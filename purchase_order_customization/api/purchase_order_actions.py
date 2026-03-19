# Copyright (c) 2024, Amr Basha and contributors
# License: MIT

import json
import frappe
from frappe import _
from frappe.utils import flt, cint, nowdate

# ──────────────────────────────────────────────────────────
#  FETCH INVOICEABLE ITEMS
# ──────────────────────────────────────────────────────────

@frappe.whitelist()
def get_invoiceable_items(purchase_order):
    """Return items from the Purchase Order that still have remaining billable qty."""
    _validate_purchase_order(purchase_order)

    po = frappe.get_doc("Purchase Order", purchase_order)

    # Aggregate billed qty per PO Item from submitted Purchase Invoices
    billed_qty_map = _get_billed_qty_map(purchase_order)

    rows = []
    for item in po.items:
        billed_qty = flt(billed_qty_map.get(item.name, 0))
        remaining = flt(item.qty) - billed_qty
        if remaining > 0:
            rows.append({
                "po_detail": item.name,
                "item_code": item.item_code,
                "item_name": item.item_name,
                "ordered_qty": flt(item.qty),
                "billed_qty": billed_qty,
                "remaining_qty": remaining,
                "rate": flt(item.rate),
                "amount": flt(remaining * item.rate),
                "warehouse": item.warehouse,
                "uom": item.uom,
            })

    return rows


# ──────────────────────────────────────────────────────────
#  FETCH RETURNABLE ITEMS
# ──────────────────────────────────────────────────────────

@frappe.whitelist()
def get_returnable_items(purchase_order):
    """Return items that were already invoiced and are still eligible for return (Debit Note)."""
    _validate_purchase_order(purchase_order)

    # Step 1: Get all submitted Purchase Invoice Items linked to this PO
    pi_items = frappe.db.sql("""
        SELECT
            pii.name           AS pi_item_name,
            pii.parent         AS purchase_invoice,
            pi.posting_date    AS invoice_date,
            pii.item_code,
            pii.item_name,
            pii.qty            AS invoiced_qty,
            pii.rate,
            pii.po_detail,
            pii.warehouse,
            pii.uom
        FROM `tabPurchase Invoice Item` pii
        INNER JOIN `tabPurchase Invoice` pi ON pi.name = pii.parent
        WHERE pii.purchase_order = %(po)s
          AND pi.docstatus = 1
          AND pi.is_return = 0
    """, {"po": purchase_order}, as_dict=True)

    if not pi_items:
        return []

    # Step 2: Get already-returned qty per (purchase_invoice, purchase_invoice_item)
    returned_qty_map = _get_returned_qty_map(purchase_order)

    rows = []
    for item in pi_items:
        key = (item.purchase_invoice, item.pi_item_name)
        already_returned = flt(returned_qty_map.get(key, 0))
        remaining = flt(item.invoiced_qty) - already_returned
        if remaining > 0:
            rows.append({
                "purchase_invoice": item.purchase_invoice,
                "invoice_date": str(item.invoice_date) if item.invoice_date else "",
                "pi_item_name": item.pi_item_name,
                "po_detail": item.po_detail,
                "item_code": item.item_code,
                "item_name": item.item_name,
                "invoiced_qty": flt(item.invoiced_qty),
                "already_returned_qty": already_returned,
                "remaining_qty": remaining,
                "rate": flt(item.rate),
                "amount": flt(remaining * item.rate),
                "warehouse": item.warehouse,
                "uom": item.uom,
            })

    return rows


# ──────────────────────────────────────────────────────────
#  CREATE PURCHASE INVOICE
# ──────────────────────────────────────────────────────────

@frappe.whitelist()
def create_purchase_invoice(args):
    """Create a Purchase Invoice from selected Purchase Order items."""
    args = _parse_args(args)

    purchase_order = args.get("purchase_order")
    items = args.get("items") or []
    submit = cint(args.get("submit"))
    create_payment = cint(args.get("create_payment"))
    mode_of_payment = args.get("mode_of_payment")

    # ── Validations ────────────────────────────────
    _validate_purchase_order(purchase_order)

    if not items:
        frappe.throw(_("Please select at least one item to invoice."))

    if create_payment and not mode_of_payment:
        frappe.throw(_("Mode of Payment is required when creating a Payment Entry."))

    po = frappe.get_doc("Purchase Order", purchase_order)
    company_update_stock = frappe.db.get_value("Company", po.company, "custom_update_stock_purchase")
    billed_qty_map = _get_billed_qty_map(purchase_order)

    # Validate each selected item
    selected_po_details = []
    qty_map = {}  # po_detail → qty_to_invoice
    for row in items:
        po_detail = row.get("po_detail")
        qty_to_invoice = flt(row.get("qty"))

        if qty_to_invoice <= 0:
            frappe.throw(_("Qty to Invoice must be greater than zero for item row {0}.").format(po_detail))

        # Find the PO item
        po_item = _find_po_item(po, po_detail)
        billed_qty = flt(billed_qty_map.get(po_detail, 0))
        remaining = flt(po_item.qty) - billed_qty

        if qty_to_invoice > remaining:
            frappe.throw(
                _("Row {0}: Qty to Invoice ({1}) exceeds Remaining Billable Qty ({2}) for {3}.").format(
                    po_item.idx, qty_to_invoice, remaining, po_item.item_code
                )
            )

        selected_po_details.append(po_detail)
        qty_map[po_detail] = qty_to_invoice

    # ── Create Purchase Invoice using ERPNext's standard mapper ──
    from erpnext.buying.doctype.purchase_order.purchase_order import make_purchase_invoice

    pi = make_purchase_invoice(
        purchase_order,
        # Note: make_purchase_invoice might handle filtered_children differently than sales_order
    )
    
    # Filtering items manually as make_purchase_invoice might not take filtered_children directly in all versions
    pi.items = [d for d in pi.items if d.po_detail in selected_po_details]

    # Override qty to match user-selected partial quantities
    for pi_item in pi.items:
        po_detail = pi_item.po_detail
        if po_detail in qty_map:
            pi_item.qty = qty_map[po_detail]
            pi_item.amount = flt(pi_item.qty * pi_item.rate)
            pi_item.base_amount = flt(pi_item.amount * (po.conversion_rate or 1))

    pi.update_stock = cint(company_update_stock)
    pi.set_missing_values()
    pi.calculate_taxes_and_totals()
    pi.insert(ignore_permissions=False)

    result = {"purchase_invoice": pi.name}

    if submit:
        pi.submit()
        result["submitted"] = True

    # ── Optional Payment Entry ─────────────────────
    if create_payment and submit:
        pe = _create_payment_entry(pi.name, mode_of_payment)
        result["payment_entry"] = pe.name

    frappe.db.commit()
    return result


# ──────────────────────────────────────────────────────────
#  AUTO-CREATE INVOICE + PAYMENT ON PO SUBMIT & PAY
# ──────────────────────────────────────────────────────────

@frappe.whitelist()
def auto_create_invoice_and_payment(purchase_order, payments, create_without_payment=0):
    """Create & Submit Purchase Invoice for ALL items in the PO + Optional Payments."""
    if isinstance(payments, str):
        payments = json.loads(payments)

    if not purchase_order:
        frappe.throw(_("Purchase Order is required."))

    po = frappe.get_doc("Purchase Order", purchase_order)
    company_update_stock = frappe.db.get_value("Company", po.company, "custom_update_stock_purchase")

    if po.docstatus == 0:
        po.submit()
    elif po.docstatus == 2:
        frappe.throw(_("Purchase Order {0} is cancelled.").format(purchase_order))
        
    create_without_payment = cint(create_without_payment)

    total_payment = 0
    if payments:
        for idx, p in enumerate(payments, 1):
            if not p.get("mode_of_payment"):
                frappe.throw(_("Row {0}: Mode of Payment is required.").format(idx))
            if flt(p.get("amount")) <= 0:
                frappe.throw(_("Row {0}: Amount must be greater than zero.").format(idx))
            total_payment += flt(p.get("amount"))

    # ── Create Purchase Invoice for ALL items ─────────
    from erpnext.buying.doctype.purchase_order.purchase_order import make_purchase_invoice

    pi = make_purchase_invoice(purchase_order)
    pi.update_stock = cint(company_update_stock)
    pi.set_missing_values()
    pi.calculate_taxes_and_totals()
    pi.insert(ignore_permissions=False)
    pi.submit()

    # ── Validation of total payment vs invoice grand total ──
    if not create_without_payment:
        if flt(total_payment, 2) != flt(pi.grand_total, 2):
            frappe.throw(
                _("Total payment amount ({0}) must match Invoice Grand Total ({1}).").format(
                    frappe.format_value(total_payment, {"fieldtype": "Currency"}),
                    frappe.format_value(pi.grand_total, {"fieldtype": "Currency"}),
                )
            )
    else:
        if flt(total_payment, 2) > flt(pi.grand_total, 2):
            frappe.throw(
                _("Total payment amount ({0}) cannot exceed Invoice Grand Total ({1}).").format(
                    frappe.format_value(total_payment, {"fieldtype": "Currency"}),
                    frappe.format_value(pi.grand_total, {"fieldtype": "Currency"}),
                )
            )

    payment_entries = []
    
    if payments:
        for p in payments:
            pe = _create_payment_entry(
                pi.name,
                p.get("mode_of_payment"),
                paid_amount=flt(p.get("amount")),
                reference_no=p.get("reference_no"),
                reference_date=p.get("reference_date"),
            )
            payment_entries.append(pe.name)

    frappe.db.commit()

    return {
        "purchase_invoice": pi.name,
        "payment_entries": payment_entries,
    }


# ──────────────────────────────────────────────────────────
#  CALCULATE RETURN TOTALS
# ──────────────────────────────────────────────────────────

@frappe.whitelist()
def calculate_return_totals(args):
    """Simulate return creation to calculate grand totals for Debit Notes."""
    args = _parse_args(args)
    items = args.get("items") or []
    if not items:
        return {"total_grand_total": 0.0}

    si_groups = {}
    for row in items:
        si_groups.setdefault(row.get("purchase_invoice"), []).append(row)

    from erpnext.controllers.sales_and_purchase_return import make_return_doc
    total_grand_total = 0.0

    for pi_name, pi_items in si_groups.items():
        try:
            return_doc = make_return_doc("Purchase Invoice", pi_name)
            pi_item_qty_map = {r["pi_item_name"]: flt(r["qty"]) for r in pi_items}

            items_to_keep = []
            for ret_item in return_doc.items:
                orig_pi_item = ret_item.purchase_invoice_item
                if orig_pi_item in pi_item_qty_map:
                    ret_item.qty = -1 * pi_item_qty_map[orig_pi_item]
                    items_to_keep.append(ret_item)
            
            return_doc.items = items_to_keep
            return_doc.run_method("calculate_taxes_and_totals")
            total_grand_total += abs(flt(return_doc.grand_total))
        except Exception:
            continue

    return {"total_grand_total": total_grand_total}


# ──────────────────────────────────────────────────────────
#  CREATE PURCHASE RETURN (DEBIT NOTE)
# ──────────────────────────────────────────────────────────

@frappe.whitelist()
def create_purchase_return(args):
    """Create Debit Note(s) from selected invoiced items."""
    args = _parse_args(args)

    purchase_order = args.get("purchase_order")
    items = args.get("items") or []
    submit = cint(args.get("submit"))
    create_without_refund = cint(args.get("create_without_refund"))
    return_reason = args.get("return_reason") or ""
    payments = args.get("payments") or []

    _validate_purchase_order(purchase_order)
    po_company = frappe.db.get_value("Purchase Order", purchase_order, "company")
    company_update_stock = frappe.db.get_value("Company", po_company, "custom_update_stock_purchase")

    if not items:
        frappe.throw(_("Please select at least one item to return."))

    total_payment = 0
    if payments:
        for idx, p in enumerate(payments, 1):
            if not p.get("mode_of_payment"):
                frappe.throw(_("Refund Row {0}: Mode of Payment is required.").format(idx))
            if flt(p.get("amount")) <= 0:
                frappe.throw(_("Refund Row {0}: Amount must be greater than zero.").format(idx))
            total_payment += flt(p.get("amount"))

    returned_qty_map = _get_returned_qty_map(purchase_order)

    si_groups = {}
    for row in items:
        pi_name = row.get("purchase_invoice")
        pi_item_name = row.get("pi_item_name")
        qty_to_return = flt(row.get("qty"))

        if qty_to_return <= 0:
            frappe.throw(_("Qty to Return must be greater than zero."))

        pi_item_doc = frappe.get_doc("Purchase Invoice Item", pi_item_name)
        key = (pi_name, pi_item_name)
        already_returned = flt(returned_qty_map.get(key, 0))
        remaining = flt(pi_item_doc.qty) - already_returned

        if qty_to_return > remaining:
            frappe.throw(
                _("Qty to Return ({0}) exceeds Remaining Returnable Qty ({1}) for item {2} in {3}.").format(
                    qty_to_return, remaining, pi_item_doc.item_code, pi_name
                )
            )

        si_groups.setdefault(pi_name, []).append({
            "pi_item_name": pi_item_name,
            "item_code": pi_item_doc.item_code,
            "qty": qty_to_return,
            "rate": flt(pi_item_doc.rate),
        })

    from erpnext.controllers.sales_and_purchase_return import make_return_doc

    result = {"returns": [], "payment_entries": []}
    total_grand_total = 0.0

    for pi_name, pi_items in si_groups.items():
        pi_item_qty_map = {r["pi_item_name"]: r["qty"] for r in pi_items}
        return_doc = make_return_doc("Purchase Invoice", pi_name)

        items_to_keep = []
        for ret_item in return_doc.items:
            orig_pi_item = ret_item.purchase_invoice_item
            if orig_pi_item in pi_item_qty_map:
                ret_item.qty = -1 * flt(pi_item_qty_map[orig_pi_item])
                ret_item.amount = flt(ret_item.qty * ret_item.rate)
                if hasattr(ret_item, 'stock_qty'):
                    ret_item.stock_qty = flt(ret_item.qty * (ret_item.conversion_factor or 1))
                items_to_keep.append(ret_item)

        return_doc.items = items_to_keep
        
        # Optional ZATCA fields if they exist
        if hasattr(return_doc, 'custom_return_reason'):
            return_doc.custom_return_reason = return_reason

        return_doc.update_stock = cint(company_update_stock)
        return_doc.run_method("calculate_taxes_and_totals")
        return_doc.insert(ignore_permissions=False)

        if submit:
            return_doc.submit()

        result["returns"].append(return_doc.name)
        total_grand_total += abs(flt(return_doc.grand_total))

    if not create_without_refund:
        if flt(total_payment, 2) != flt(total_grand_total, 2):
            frappe.throw(
                _("Total refund amount ({0}) must match Returns Grand Total ({1}).").format(
                    frappe.format_value(total_payment, {"fieldtype": "Currency"}),
                    frappe.format_value(total_grand_total, {"fieldtype": "Currency"}),
                )
            )
    else:
        if flt(total_payment, 2) > flt(total_grand_total, 2):
            frappe.throw(
                _("Total refund amount ({0}) cannot exceed Returns Grand Total ({1}).").format(
                    frappe.format_value(total_payment, {"fieldtype": "Currency"}),
                    frappe.format_value(total_grand_total, {"fieldtype": "Currency"}),
                )
            )

    if total_payment > 0:
        remaining_payments = payments[:]
        for return_name in result["returns"]:
            if not remaining_payments:
                break
            
            return_doc = frappe.get_doc("Purchase Invoice", return_name)
            available_to_refund = abs(flt(return_doc.grand_total))
            
            new_remaining = []
            for p in remaining_payments:
                if available_to_refund <= 0:
                    new_remaining.append(p)
                    continue
                
                amount_to_pay = min(flt(p.get("amount")), available_to_refund)
                if amount_to_pay > 0:
                    pe = _create_payment_entry(
                        return_doc.name,
                        p.get("mode_of_payment"),
                        paid_amount=amount_to_pay,
                        reference_no=p.get("reference_no"),
                        reference_date=p.get("reference_date"),
                    )
                    result["payment_entries"].append(pe.name)
                    available_to_refund -= amount_to_pay
                    p["amount"] = flt(p["amount"]) - amount_to_pay
                
                if flt(p.get("amount", 0)) > 0:
                    new_remaining.append(p)
            
            remaining_payments = new_remaining

    frappe.db.commit()
    return result


# ──────────────────────────────────────────────────────────
#  GET LAST PURCHASE RATE
# ──────────────────────────────────────────────────────────

@frappe.whitelist()
def get_last_purchase_rate(supplier, item_code, uom=None):
    """Return the rate from the most recent submitted Purchase Order for this supplier and item."""
    if not supplier or not item_code:
        return 0.0
        
    query = """
        SELECT
            pii.rate
        FROM `tabPurchase Order Item` pii
        INNER JOIN `tabPurchase Order` po ON po.name = pii.parent
        WHERE po.supplier = %(supplier)s
          AND pii.item_code = %(item_code)s
          AND po.docstatus = 1
    """
    
    params = {
        "supplier": supplier,
        "item_code": item_code
    }
    
    if uom:
        query += " AND pii.uom = %(uom)s"
        params["uom"] = uom
        
    query += " ORDER BY po.transaction_date DESC, po.creation DESC LIMIT 1"
    
    rate = frappe.db.sql(query, params)
    
    return flt(rate[0][0]) if rate else 0.0


# ──────────────────────────────────────────────────────────
#  PRINT INVOICE API
# ──────────────────────────────────────────────────────────

@frappe.whitelist()
def get_purchase_invoice_print_url(purchase_order):
    """Get the print URL for the connected Purchase Invoice."""
    po_doc = frappe.get_doc("Purchase Order", purchase_order)
    
    pi_name = frappe.db.sql('''
        SELECT parent 
        FROM `tabPurchase Invoice Item` 
        WHERE purchase_order = %(po)s AND docstatus = 1
        LIMIT 1
    ''', {"po": purchase_order})
    
    if not pi_name:
        frappe.throw(_("No valid Purchase Invoice found for this Purchase Order."))
        
    pi_name = pi_name[0][0]
    
    settings = frappe.db.get_value("Company", po_doc.company, 
        ["custom_purchase_order_print_format_button", "custom_print_purchase_order_matrix"], as_dict=True)
    
    print_format = settings.get("custom_purchase_order_print_format_button")
    use_matrix = settings.get("custom_print_purchase_order_matrix")
    
    if not print_format:
        frappe.throw(_("Print Format not configured in Company {0}.").format(po_doc.company))

    from urllib.parse import urlencode
    
    if use_matrix:
        params = {
            "doctype": "Purchase Invoice",
            "name": pi_name,
            "trigger_print": 1,
            "format": print_format,
            "no_letterhead": 1,
            "letterhead": "No Letterhead",
            "settings": "{}",
            "_lang": "en"
        }
        url = f"/printview?{urlencode(params)}"
    else:
        params = {
            "doctype": "Purchase Invoice",
            "name": pi_name,
            "format": print_format
        }
        url = f"/api/method/frappe.utils.print_format.download_pdf?{urlencode(params)}"
        
    return {"url": url}

@frappe.whitelist()
def get_purchase_returns(purchase_order):
    """Return a list of submitted Purchase Invoices that are returns (Debit Notes) for this PO."""
    if not purchase_order:
        return []

    return frappe.db.sql("""
        SELECT DISTINCT
            pi.name,
            pi.posting_date
        FROM `tabPurchase Invoice` pi
        INNER JOIN `tabPurchase Invoice Item` pii ON pii.parent = pi.name
        WHERE pii.purchase_order = %(po)s
          AND pi.is_return = 1
          AND pi.docstatus = 1
        ORDER BY pi.posting_date DESC, pi.creation DESC
    """, {"po": purchase_order}, as_dict=True)

@frappe.whitelist()
def get_purchase_return_print_url(invoice_name, purchase_order):
    """Get the print URL for a specific Purchase Return (Debit Note)."""
    po_doc = frappe.get_doc("Purchase Order", purchase_order)
    
    settings = frappe.db.get_value("Company", po_doc.company, 
        ["custom_purchase_order_return_print_format_button", "custom_print_purchase_order_return_matrix"], as_dict=True)
    
    print_format = settings.get("custom_purchase_order_return_print_format_button")
    use_matrix = settings.get("custom_print_purchase_order_return_matrix")
    
    if not print_format:
        frappe.throw(_("Print Format not configured in Company {0}.").format(po_doc.company))

    from urllib.parse import urlencode
    
    if use_matrix:
        params = {
            "doctype": "Purchase Invoice",
            "name": invoice_name,
            "trigger_print": 1,
            "format": print_format,
            "no_letterhead": 1,
            "letterhead": "No Letterhead",
            "settings": "{}",
            "_lang": "en"
        }
        url = f"/printview?{urlencode(params)}"
    else:
        params = {
            "doctype": "Purchase Invoice",
            "name": invoice_name,
            "format": print_format
        }
        url = f"/api/method/frappe.utils.print_format.download_pdf?{urlencode(params)}"
        
    return {"url": url}


# ──────────────────────────────────────────────────────────
#  GET SUPPLIER OUTSTANDING
# ──────────────────────────────────────────────────────────

@frappe.whitelist()
def get_supplier_outstanding_amount(supplier, company):
    """Get the calculated outstanding amount for a supplier in a specific company."""
    from erpnext.accounts.party import get_dashboard_info
    company_wise_info = get_dashboard_info("Supplier", supplier)
    for info in company_wise_info:
        if info.get("company") == company:
            return info.get("total_unpaid", 0)
    return 0


# ──────────────────────────────────────────────────────────
#  GET ITEM HISTORY FOR ACTION BUTTON
# ──────────────────────────────────────────────────────────

@frappe.whitelist()
def get_item_warehouse_data(item_code, company=None):
    """Return warehouse stock data for a specific item (alternative to standard dashboard API)."""
    if not item_code:
        return []
    
    conditions = "item_code = %(item_code)s"
    # To handle cases where company is provided but might not be relevant to bin directly without join
    # Bin typically has a warehouse field, and Warehouse has a company field.
    
    sql = """
        SELECT
            b.warehouse as warehouse_name,
            b.actual_qty,
            b.projected_qty,
            b.reserved_qty
        FROM `tabBin` b
        WHERE b.item_code = %(item_code)s
    """
    
    if company:
        sql += " AND EXISTS (SELECT name FROM `tabWarehouse` w WHERE w.name = b.warehouse AND w.company = %(company)s)"
        
    sql += " ORDER BY b.actual_qty DESC"

    return frappe.db.sql(sql, {
        "item_code": item_code,
        "company": company
    }, as_dict=True)

@frappe.whitelist()
def get_item_sales_history(item_code, limit=5, start=0):
    """Return recent sales history for a specific item across all customers."""
    if not item_code:
        return []

    return frappe.db.sql("""
        SELECT
            si.posting_date,
            sii.parent AS invoice_name,
            si.customer,
            sii.rate,
            sii.qty,
            sii.uom,
            sii.amount
        FROM `tabSales Invoice Item` sii
        INNER JOIN `tabSales Invoice` si ON si.name = sii.parent
        WHERE sii.item_code = %(item_code)s
          AND si.docstatus = 1
        ORDER BY si.posting_date DESC, si.creation DESC
        LIMIT %(limit)s OFFSET %(start)s
    """, {
        "item_code": item_code,
        "limit": cint(limit),
        "start": cint(start)
    }, as_dict=True)

@frappe.whitelist()
def get_item_purchase_history(item_code, limit=5, start=0):
    """Return recent purchase history for a specific item across all suppliers."""
    if not item_code:
        return []

    return frappe.db.sql("""
        SELECT
            pi.posting_date,
            pii.parent AS invoice_name,
            pi.supplier,
            pii.rate,
            pii.qty,
            pii.uom,
            pii.amount
        FROM `tabPurchase Invoice Item` pii
        INNER JOIN `tabPurchase Invoice` pi ON pi.name = pii.parent
        WHERE pii.item_code = %(item_code)s
          AND pi.docstatus = 1
        ORDER BY pi.posting_date DESC, pi.creation DESC
        LIMIT %(limit)s OFFSET %(start)s
    """, {
        "item_code": item_code,
        "limit": cint(limit),
        "start": cint(start)
    }, as_dict=True)

@frappe.whitelist()
def get_item_stock_and_conversion(item_code, warehouse, uom=None):
    """Return actual_qty from Bin and conversion_factor from UOM Conversion Detail."""
    actual_qty = 0.0
    conversion_factor = 1.0
    
    if item_code and warehouse:
        bin_qty = frappe.db.get_value("Bin", {"item_code": item_code, "warehouse": warehouse}, "actual_qty")
        if bin_qty is not None:
            actual_qty = flt(bin_qty)
            
    if item_code and uom:
        cf = frappe.db.get_value("UOM Conversion Detail", {"parent": item_code, "uom": uom}, "conversion_factor")
        if cf is not None:
            conversion_factor = flt(cf)
            
    return {
        "actual_qty": actual_qty,
        "conversion_factor": conversion_factor
    }

# ──────────────────────────────────────────────────────────
#  INTERNAL HELPERS
# ──────────────────────────────────────────────────────────

def _validate_purchase_order(purchase_order):
    if not purchase_order:
        frappe.throw(_("Purchase Order is required."))

    po = frappe.get_doc("Purchase Order", purchase_order)

    if not frappe.has_permission("Purchase Order", "read", po):
        frappe.throw(_("You do not have permission to access this Purchase Order."), frappe.PermissionError)

    if po.docstatus != 1:
        frappe.throw(_("Purchase Order {0} must be submitted before creating invoices or returns.").format(purchase_order))

    if po.status in ("Cancelled", "Closed"):
        frappe.throw(_("Cannot create documents against a {0} Purchase Order.").format(po.status))


def _find_po_item(po, po_detail):
    for item in po.items:
        if item.name == po_detail:
            return item
    frappe.throw(_("Purchase Order Item {0} not found.").format(po_detail))


def _get_billed_qty_map(purchase_order):
    data = frappe.db.sql("""
        SELECT
            pii.po_detail,
            SUM(pii.qty) AS billed_qty
        FROM `tabPurchase Invoice Item` pii
        INNER JOIN `tabPurchase Invoice` pi ON pi.name = pii.parent
        WHERE pii.purchase_order = %(po)s
          AND pi.docstatus = 1
          AND pi.is_return = 0
        GROUP BY pii.po_detail
    """, {"po": purchase_order}, as_dict=True)

    return {d.po_detail: flt(d.billed_qty) for d in data}


def _get_returned_qty_map(purchase_order):
    data = frappe.db.sql("""
        SELECT
            ret_item.purchase_invoice_item,
            pi_orig.name AS original_invoice,
            SUM(ABS(ret_item.qty)) AS returned_qty
        FROM `tabPurchase Invoice Item` ret_item
        INNER JOIN `tabPurchase Invoice` ret_pi ON ret_pi.name = ret_item.parent
        INNER JOIN `tabPurchase Invoice` pi_orig ON pi_orig.name = ret_pi.return_against
        INNER JOIN `tabPurchase Invoice Item` orig_item
            ON orig_item.name = ret_item.purchase_invoice_item
            AND orig_item.parent = pi_orig.name
        WHERE orig_item.purchase_order = %(po)s
          AND ret_pi.docstatus = 1
          AND ret_pi.is_return = 1
        GROUP BY ret_item.purchase_invoice_item, pi_orig.name
    """, {"po": purchase_order}, as_dict=True)

    return {
        (d.original_invoice, d.purchase_invoice_item): flt(d.returned_qty)
        for d in data
    }


def _create_payment_entry(purchase_invoice_name, mode_of_payment,
                           paid_amount=None, reference_no=None, reference_date=None):
    from erpnext.accounts.doctype.payment_entry.payment_entry import get_payment_entry
    from erpnext.accounts.doctype.journal_entry.journal_entry import get_default_bank_cash_account

    pi = frappe.get_doc("Purchase Invoice", purchase_invoice_name)

    bank_account_info = get_default_bank_cash_account(
        pi.company, account_type=None, mode_of_payment=mode_of_payment
    )

    bank_account = bank_account_info.get("account") if bank_account_info else None

    pe = get_payment_entry(
        dt="Purchase Invoice",
        dn=purchase_invoice_name,
        bank_account=bank_account,
    )

    pe.mode_of_payment = mode_of_payment

    if paid_amount is not None and flt(paid_amount) > 0:
        paid_amount = flt(paid_amount)
        pe.paid_amount = paid_amount
        pe.received_amount = paid_amount
        pe.base_paid_amount = flt(paid_amount * flt(pe.source_exchange_rate, 1.0))
        pe.base_received_amount = flt(paid_amount * flt(pe.target_exchange_rate, 1.0))
        pe.unallocated_amount = 0

        if pe.references:
            if getattr(pi, "is_return", 0):
                pe.references[0].allocated_amount = -paid_amount
            else:
                pe.references[0].allocated_amount = paid_amount

    if reference_no:
        pe.reference_no = reference_no
    if reference_date:
        pe.reference_date = reference_date

    if bank_account:
        if pe.payment_type == "Pay":
            pe.paid_from = bank_account
            pe.paid_from_account_currency = bank_account_info.get("account_currency")
        else:
            pe.paid_to = bank_account
            pe.paid_to_account_currency = bank_account_info.get("account_currency")

    pe.insert(ignore_permissions=False)
    pe.submit()

    return pe


def _parse_args(args):
    if isinstance(args, str):
        args = json.loads(args)
    return frappe._dict(args)
