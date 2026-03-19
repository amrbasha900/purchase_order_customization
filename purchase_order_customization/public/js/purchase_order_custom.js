/**
 * Purchase Order Customization
 *
 * - "Submit & Pay" button on draft PO → dialog with payments table → submit PO + auto-create PI + PEs
 * - Standard Submit button works normally
 * - "Create Return" button on submitted PO → simplified dialog with return reason + multi-refund table
 */

frappe.ui.form.on("Purchase Order", {
    buying_price_list(frm) {
        if (frm.custom_item_search_po) {
            $('#quick_item_search_po').val('');
            $('#search_results_po').hide();
        }

 },

    onload(frm) {
        remove_rows_without_item_code_po(frm);
        remove_rows_without_item_code_po(frm);
        if (frm.is_new() && !frm.doc.schedule_date) {
            frm.set_value("schedule_date", frappe.datetime.get_today());
        }
    },

    refresh(frm) {
        add_quick_item_search_po(frm);
        toggle_quick_add_visibility_po(frm);
        add_offline_items_sync_button_po(frm);
        attach_items_grid_details_buttons_po(frm);
        setTimeout(() => attach_items_grid_details_buttons_po(frm), 300);
        add_quick_item_search_po(frm);
        toggle_quick_add_visibility_po(frm);
        add_offline_items_sync_button_po(frm);
        attach_items_grid_details_buttons_po(frm);
        setTimeout(() => attach_items_grid_details_buttons_po(frm), 300);
        // ── Draft: show "Submit & Pay" button ─────────
        if (frm.doc.docstatus === 0 && !frm.is_new()) {
            frm.add_custom_button(
                __("Submit & Pay"),
                () => show_submit_and_pay_dialog(frm),
            );
            frm.custom_buttons[__("Submit & Pay")]
                && frm.custom_buttons[__("Submit & Pay")].addClass("btn-primary-dark");
        }

        // ── Submitted: show "Create Return" and "Print Invoice" as top-level buttons ────
        if (frm.doc.docstatus !== 1) return;
        if (["Cancelled", "Closed"].includes(frm.doc.status)) return;

        // Print Invoice button
        if (["To Receive and Bill", "To Bill", "To Receive", "Completed"].includes(frm.doc.status)) {
            frm.add_custom_button(
                __("Print Invoice"),
                function () {
                    frappe.call({
                        method: "purchase_order_customization.api.purchase_order_actions.get_purchase_invoice_print_url",
                        args: { purchase_order: frm.doc.name },
                        callback: function (r) {
                            if (r.message && r.message.url) {
                                window.open(r.message.url, "_blank");
                            }
                        }
                    });
                }
            );
            frm.custom_buttons[__("Print Invoice")]
                && frm.custom_buttons[__("Print Invoice")].addClass("btn-default");
        }

        // Create Return button
        frappe.call({
            method: "purchase_order_customization.api.purchase_order_actions.get_returnable_items",
            args: { purchase_order: frm.doc.name },
            async: true,
            callback(r) {
                if (r.message && r.message.length) {
                    frm.add_custom_button(
                        __("Create Return"),
                        () => show_return_dialog(frm, r.message),
                    );
                    frm.custom_buttons[__("Create Return")]
                        && frm.custom_buttons[__("Create Return")].addClass("btn-default");
                }
            }
        });

        // Print Purchase Return button
        frappe.call({
            method: "purchase_order_customization.api.purchase_order_actions.get_purchase_returns",
            args: { purchase_order: frm.doc.name },
            callback: function (r) {
                if (r.message && r.message.length) {
                    frm.add_custom_button(
                        __("Print Purchase Return"),
                        function () {
                            handle_print_purchase_return(frm, r.message);
                        }
                    );
                    frm.custom_buttons[__("Print Purchase Return")]
                        && frm.custom_buttons[__("Print Purchase Return")].addClass("btn-default");
                }
            }
        });
    },

    supplier(frm) {
        remove_rows_without_item_code_po(frm);
        toggle_quick_add_visibility_po(frm);

        if (frm.doc.supplier && frm.doc.company) {
            // Fetch supplier outstanding amount  
            frappe.call({
                method: 'purchase_order_customization.api.purchase_order_actions.get_supplier_outstanding_amount',
                args: {
                    supplier: frm.doc.supplier,
                    company: frm.doc.company
                },
                callback: function (r) {
                    if (r.message !== undefined) {
                        frm.set_value('custom_supplier_balance', r.message);
                    }
                }
            });
        } else {
            frm.set_value('custom_supplier_balance', 0);
        }

        if (!frm.doc.supplier || !frm.doc.items || !frm.doc.items.length) return;

        // Iterate through all items and update the custom_last_rate for the new supplier
        frm.doc.items.forEach(row => {
            if (row.item_code) {
                frappe.call({
                    method: "purchase_order_customization.api.purchase_order_actions.get_last_purchase_rate",
                    args: {
                        supplier: frm.doc.supplier,
                        item_code: row.item_code,
                        uom: row.uom
                    },
                    callback: function (r) {
                        if (r.message !== undefined) {
                            frappe.model.set_value(row.doctype, row.name, "custom_last_rate", flt(r.message));
                        }
                    }
                });
            }
        });
    }
});

// ═══════════════════════════════════════════════════════
//  SUBMIT & PAY DIALOG
// ═══════════════════════════════════════════════════════

function show_submit_and_pay_dialog(frm) {
    const grand_total = flt(frm.doc.grand_total) || flt(frm.doc.rounded_total) || 0;

    const d = new frappe.ui.Dialog({
        title: __("Submit & Pay"),
        size: "large",
        fields: [
            {
                fieldname: "total_info",
                fieldtype: "HTML",
                options: `<div class="text-muted" style="margin-bottom:10px;">
                    ${__("Grand Total")}: <strong>${format_currency(grand_total, frm.doc.currency)}</strong>
                </div>`,
            },
            {
                fieldname: "create_without_payment",
                fieldtype: "Check",
                label: __("Create Invoice without Payment"),
                default: 0
            },
            {
                fieldname: "payments",
                fieldtype: "Table",
                label: __("Payments"),
                cannot_add_rows: false,
                in_place_edit: true,
                fields: [
                    {
                        fieldname: "mode_of_payment",
                        fieldtype: "Link",
                        options: "Mode of Payment",
                        label: __("Mode of Payment"),
                        in_list_view: 1,
                        reqd: 1,
                        columns: 3,
                    },
                    {
                        fieldname: "amount",
                        fieldtype: "Currency",
                        label: __("Amount"),
                        in_list_view: 1,
                        reqd: 1,
                        columns: 2,
                    },
                    {
                        fieldname: "reference_no",
                        fieldtype: "Data",
                        label: __("Reference / Cheque No"),
                        in_list_view: 1,
                        columns: 3,
                    },
                    {
                        fieldname: "reference_date",
                        fieldtype: "Date",
                        label: __("Reference Date"),
                        in_list_view: 1,
                        columns: 2,
                    },
                ],
                data: [],
            },
        ],
        primary_action_label: __("Submit & Pay"),
        primary_action(values) {
            const create_without_payment = !!values.create_without_payment;
            const payments = values.payments || [];

            if (!create_without_payment) {
                if (!payments.length) {
                    frappe.msgprint(__("Please add at least one payment row."));
                    return;
                }

                let total_payment = 0;
                for (const [idx, p] of payments.entries()) {
                    if (!p.mode_of_payment) {
                        frappe.msgprint(__("Row {0}: Mode of Payment is required.", [idx + 1]));
                        return;
                    }
                    if (flt(p.amount) <= 0) {
                        frappe.msgprint(__("Row {0}: Amount must be greater than zero.", [idx + 1]));
                        return;
                    }
                    total_payment += flt(p.amount);
                }

                if (flt(total_payment, 2) !== flt(grand_total, 2)) {
                    frappe.msgprint(
                        __("Total payment ({0}) must match Grand Total ({1}).", [
                            format_currency(total_payment, frm.doc.currency),
                            format_currency(grand_total, frm.doc.currency),
                        ])
                    );
                    return;
                }
            }

            d.hide();

            (frm.is_dirty() ? frm.save() : Promise.resolve()).then(() => {
                return frappe.xcall(
                    "purchase_order_customization.api.purchase_order_actions.auto_create_invoice_and_payment",
                    {
                        purchase_order: frm.doc.name,
                        create_without_payment: create_without_payment ? 1 : 0,
                        payments: payments.map((p) => ({
                            mode_of_payment: p.mode_of_payment,
                            amount: flt(p.amount),
                            reference_no: p.reference_no || "",
                            reference_date: p.reference_date || "",
                        })),
                    }
                );
            })
                .then((result) => {
                    let msg = __("Purchase Invoice {0} created and submitted.", [
                        `<a href="/app/purchase-invoice/${result.purchase_invoice}">${result.purchase_invoice}</a>`,
                    ]);
                    (result.payment_entries || []).forEach((pe_name) => {
                        msg += "<br>" + __("Payment Entry {0} created.", [
                            `<a href="/app/payment-entry/${pe_name}">${pe_name}</a>`,
                        ]);
                    });
                    frappe.show_alert({ message: msg, indicator: "green" }, 5);
                    frm.reload_doc();
                })
                .catch((err) => {
                    frappe.msgprint({
                        message: __("An error occurred. Please check the error log and try again."),
                        indicator: "red",
                        title: __("Error"),
                    });
                    frm.reload_doc();
                });
        },
    });

    d.show();
    setup_payment_grid_auto_amount(d, "payments", () => grand_total);
}

// ═══════════════════════════════════════════════════════
//  RETURN DIALOG (Simplified for Purchase Returns)
// ═══════════════════════════════════════════════════════

function show_return_dialog(frm, rows) {
    let calculated_grand_total = 0;

    const dialog = show_action_dialog({
        title: __("Create Purchase Return / Debit Note"),
        frm,
        rows,
        columns: get_return_columns(),
        on_change(selected) {
            if (!selected.length) {
                calculated_grand_total = 0;
                dialog.fields_dict.total_refund_info.$wrapper.html("");
                return;
            }

            frappe.call({
                method: "purchase_order_customization.api.purchase_order_actions.calculate_return_totals",
                args: {
                    args: JSON.stringify({
                        items: selected.map(r => ({
                            purchase_invoice: r.purchase_invoice,
                            pi_item_name: r.pi_item_name,
                            qty: flt(r.qty)
                        }))
                    })
                },
                callback(r) {
                    if (r.message) {
                        calculated_grand_total = flt(r.message.total_grand_total);
                        const html = `
                            <div class="alert alert-info" style="margin-top:10px; margin-bottom:0;">
                                ${__("Expected Refund Amount (Incl. Taxes)")}: 
                                <strong>${format_currency(calculated_grand_total, frm.doc.currency)}</strong>
                            </div>
                        `;
                        dialog.fields_dict.total_refund_info.$wrapper.html(html);
                    }
                }
            });
        },
        row_mapper: (r) => ({
            purchase_invoice: r.purchase_invoice,
            pi_item_name: r.pi_item_name,
            po_detail: r.po_detail,
            item_code: r.item_code,
            item_name: r.item_name,
            invoiced_qty: r.invoiced_qty,
            already_returned_qty: r.already_returned_qty,
            remaining_qty: r.remaining_qty,
            qty: r.remaining_qty,
            rate: r.rate,
            amount: r.amount,
        }),
        qty_field: "qty",
        max_qty_field: "remaining_qty",
        option_fields: [
            {
                fieldname: "total_refund_info",
                fieldtype: "HTML",
            },
            {
                fieldname: "return_reason",
                label: __("Return Reason"),
                fieldtype: "Data",
                reqd: 0,
            },
            { fieldtype: "Section Break" },
            {
                fieldname: "create_without_refund",
                label: __("Create Return without Refund"),
                fieldtype: "Check",
                default: 0,
            },
            {
                fieldname: "refund_payments_section",
                fieldtype: "Section Break",
                label: __("Refund Payments"),
            },
            {
                fieldname: "refund_payments",
                fieldtype: "Table",
                label: __("Refund Payments"),
                fields: [
                    { fieldname: "mode_of_payment", fieldtype: "Link", options: "Mode of Payment", label: __("Mode of Payment"), in_list_view: 1, reqd: 1, columns: 3 },
                    { fieldname: "amount", fieldtype: "Currency", label: __("Amount"), in_list_view: 1, reqd: 1, columns: 2 },
                    { fieldname: "reference_no", fieldtype: "Data", label: __("Reference"), in_list_view: 1, columns: 3 },
                    { fieldname: "reference_date", fieldtype: "Date", label: __("Date"), in_list_view: 1, columns: 2 },
                ],
                data: [],
            },
        ],
        on_submit(selected, opts) {
            if (!selected.length) {
                frappe.msgprint(__("Please select at least one item."));
                return;
            }

            const create_without_refund = opts.create_without_refund;
            let refund_payments = opts.refund_payments || [];

            let total_refund = 0;
            refund_payments.forEach(p => total_refund += flt(p.amount));

            if (!create_without_refund && flt(total_refund, 2) !== flt(calculated_grand_total, 2)) {
                frappe.msgprint(__("Total refund amount ({0}) must match Returns Grand Total ({1}).", [
                    format_currency(total_refund, frm.doc.currency),
                    format_currency(calculated_grand_total, frm.doc.currency)
                ]));
                return;
            }

            dialog.hide();

            frappe.call({
                method: "purchase_order_customization.api.purchase_order_actions.create_purchase_return",
                args: {
                    args: JSON.stringify({
                        purchase_order: frm.doc.name,
                        items: selected.map((r) => ({
                            purchase_invoice: r.purchase_invoice,
                            pi_item_name: r.pi_item_name,
                            qty: flt(r.qty),
                        })),
                        submit: 1,
                        return_reason: opts.return_reason || "",
                        create_without_refund: create_without_refund ? 1 : 0,
                        payments: refund_payments,
                    }),
                },
                freeze: true,
                callback(r) {
                    if (r.message) {
                        let msg = "";
                        (r.message.returns || []).forEach(name => msg += __("Debit Note {0} created.", [`<a href="/app/purchase-invoice/${name}">${name}</a>`]) + "<br>");
                        (r.message.payment_entries || []).forEach(name => msg += __("Payment Entry {0} created.", [`<a href="/app/payment-entry/${name}">${name}</a>`]) + "<br>");
                        frappe.show_alert({ message: msg, indicator: "green" });
                        frm.reload_doc();
                    }
                },
            });
        },
    });

    setup_payment_grid_auto_amount(dialog, "refund_payments", () => calculated_grand_total);
}

// ═══════════════════════════════════════════════════════
//  HELPERS & REUSABLE COMPONENTS
// ═══════════════════════════════════════════════════════

function setup_payment_grid_auto_amount(dialog, fieldname, get_total_fn) {
    const grid = dialog.fields_dict[fieldname] && dialog.fields_dict[fieldname].grid;
    if (!grid) return;

    const original_add_new_row = grid.add_new_row.bind(grid);
    grid.add_new_row = function (...args) {
        const result = original_add_new_row(...args);
        const data = grid.get_data() || [];
        if (!data.length) return result;

        let already_filled = 0;
        data.forEach((row, i) => { if (i < data.length - 1) already_filled += flt(row.amount); });

        const total = flt(get_total_fn());
        const remaining = total - already_filled;
        data[data.length - 1].amount = remaining > 0 ? remaining : 0;
        grid.refresh();
        return result;
    };
}

function show_action_dialog(opts) {
    const fields = [{ fieldname: "items_html", fieldtype: "HTML" }, { fieldtype: "Section Break" }, ...(opts.option_fields || [])];
    const dialog = new frappe.ui.Dialog({
        title: opts.title,
        size: "extra-large",
        fields,
        primary_action_label: __("Create"),
        primary_action() {
            const selected = get_selected_rows(dialog);
            const values = {};
            (opts.option_fields || []).forEach(f => { if (f.fieldname) values[f.fieldname] = dialog.get_value(f.fieldname); });
            opts.on_submit(selected, values);
        },
    });

    const rows = (opts.rows || []).map(opts.row_mapper);
    render_items_table(dialog, opts.columns, rows, opts.qty_field, opts.max_qty_field, opts.on_change);
    dialog.show();
    return dialog;
}

function render_items_table(dialog, columns, rows, qty_field, max_qty_field, on_change) {
    const wrapper = dialog.fields_dict.items_html.$wrapper;
    let html = `<div style="max-height:400px;overflow:auto;"><table class="table table-bordered table-hover"><thead><tr><th><input type="checkbox" class="select-all"></th>`;
    columns.forEach(col => html += `<th>${col.label}</th>`);
    html += `</tr></thead><tbody>`;
    rows.forEach((row, idx) => {
        html += `<tr data-idx="${idx}"><td><input type="checkbox" class="row-check" data-idx="${idx}"></td>`;
        columns.forEach(col => {
            const val = row[col.fieldname] ?? "";
            if (col.fieldname === qty_field) html += `<td><input type="number" class="form-control input-sm qty-input" data-idx="${idx}" data-max="${row[max_qty_field]}" value="${val}" style="width:100px"></td>`;
            else html += `<td>${col.fieldtype === 'Currency' ? format_currency(val) : val}</td>`;
        });
        html += `</tr>`;
    });
    html += `</tbody></table></div>`;
    wrapper.html(html);
    dialog._table_rows = rows;

    wrapper.find(".select-all").on("change", function () { wrapper.find(".row-check").prop("checked", this.checked); on_change && on_change(get_selected_rows(dialog)); });
    wrapper.find(".row-check").on("change", () => on_change && on_change(get_selected_rows(dialog)));
    wrapper.find(".qty-input").on("change input", function () {
        const idx = $(this).data("idx");
        let val = flt($(this).val());
        const max = flt($(this).data("max"));
        if (val > max) { val = max; $(this).val(val); }
        rows[idx][qty_field] = val;
        on_change && on_change(get_selected_rows(dialog));
    });
}

function get_selected_rows(dialog) {
    const selected = [];
    dialog.fields_dict.items_html.$wrapper.find(".row-check:checked").each(function () { selected.push(dialog._table_rows[$(this).data("idx")]); });
    return selected;
}

function get_return_columns() {
    return [
        { fieldname: "item_code", label: __("Item Code") },
        { fieldname: "item_name", label: __("Item Name") },
        { fieldname: "invoiced_qty", label: __("Invoiced Qty"), fieldtype: "Float" },
        { fieldname: "remaining_qty", label: __("Remaining"), fieldtype: "Float" },
        { fieldname: "qty", label: __("Return Qty"), fieldtype: "Float" },
        { fieldname: "rate", label: __("Rate"), fieldtype: "Currency" }
    ];
}

frappe.ui.form.on("Purchase Order Item", {
    item_code: (frm, cdt, cdn) => {
        update_last_purchase_rate(frm, cdt, cdn);
    },
    uom: (frm, cdt, cdn) => {
        update_last_purchase_rate(frm, cdt, cdn);
    },
    conversion_factor: (frm, cdt, cdn) => {
        update_actual_qty_in_uom(frm, cdt, cdn);
    },
    warehouse: (frm, cdt, cdn) => {
        update_actual_qty_in_uom(frm, cdt, cdn);
    },
    custom_action(frm, cdt, cdn) {
        const row = locals[cdt][cdn];
        if (row.item_code) show_item_dashboard_dialog(frm, row);
    }
});

function update_actual_qty_in_uom(frm, cdt, cdn) {
    let row = locals[cdt][cdn];

    if (row.item_code && row.warehouse) {
        frappe.call({
            method: "purchase_order_customization.api.purchase_order_actions.get_item_stock_and_conversion",
            args: {
                item_code: row.item_code,
                warehouse: row.warehouse,
                uom: row.uom
            },
            callback: function (r) {
                if (r.message) {
                    let actual_qty = flt(r.message.actual_qty);
                    let cf = flt(r.message.conversion_factor) || 1;

                    // Update actual_qty (standard behavior)  
                    frappe.model.set_value(cdt, cdn, "actual_qty", actual_qty);

                    // Calculate and update converted quantity  
                    if (cf > 0) {
                        let converted_qty = actual_qty / cf;
                        frappe.model.set_value(cdt, cdn, "actual_qty_in_uom", converted_qty);
                    } else {
                        frappe.model.set_value(cdt, cdn, "actual_qty_in_uom", actual_qty);
                    }
                }
            }
        });
    }
}

function update_last_purchase_rate(frm, cdt, cdn) {
    const row = locals[cdt][cdn];
    if (!frm.doc.supplier || !row.item_code) return;
    frappe.call({
        method: "purchase_order_customization.api.purchase_order_actions.get_last_purchase_rate",
        args: { supplier: frm.doc.supplier, item_code: row.item_code, uom: row.uom },
        callback: (r) => frappe.model.set_value(cdt, cdn, "custom_last_rate", flt(r.message))
    });
}

// ═══════════════════════════════════════════════════════
//  ITEM DASHBOARD UI
// ═══════════════════════════════════════════════════════

function show_item_dashboard_dialog(frm, row) {
    const dialog = new frappe.ui.Dialog({
        title: __("Item Dashboard: {0}", [row.item_code]),
        size: "extra-large",
        fields: [
            {
                fieldname: "dashboard_html",
                fieldtype: "HTML"
            }
        ]
    });

    const unique_id = frappe.utils.get_random(8);
    const html = `
        <div class="item-dashboard-container">
            <ul class="nav nav-tabs" role="tablist">
                <li class="nav-item">
                    <a class="nav-link active" data-toggle="tab" data-target="#tab-stock-${unique_id}" role="tab" style="cursor: pointer;">${__("Warehouse Stock")}</a>
                </li>
                <li class="nav-item">
                    <a class="nav-link" data-toggle="tab" data-target="#tab-sales-${unique_id}" role="tab" style="cursor: pointer;">${__("Sales History")}</a>
                </li>
                <li class="nav-item">
                    <a class="nav-link" data-toggle="tab" data-target="#tab-purchases-${unique_id}" role="tab" style="cursor: pointer;">${__("Purchase History")}</a>
                </li>
            </ul>
            <div class="tab-content" style="padding-top: 15px; min-height: 300px;">
                <div class="tab-pane active" id="tab-stock-${unique_id}" role="tabpanel">
                    <div class="text-muted">${__("Loading...")}</div>
                </div>
                <div class="tab-pane" id="tab-sales-${unique_id}" role="tabpanel">
                    <div class="text-muted">${__("Loading...")}</div>
                </div>
                <div class="tab-pane" id="tab-purchases-${unique_id}" role="tabpanel">
                    <div class="text-muted">${__("Loading...")}</div>
                </div>
            </div>
        </div>
    `;

    dialog.fields_dict.dashboard_html.$wrapper.html(html);

    dialog.show();

    load_warehouse_stock(frm, row.item_code, dialog.fields_dict.dashboard_html.$wrapper.find(`#tab-stock-${unique_id}`));

    let sales_loaded = false;
    let purchases_loaded = false;

    dialog.fields_dict.dashboard_html.$wrapper.find('a[data-toggle="tab"]').on('shown.bs.tab', function (e) {
        const target = $(e.target).attr("data-target");
        if (target === `#tab-sales-${unique_id}` && !sales_loaded) {
            sales_loaded = true;
            load_sales_history(row.item_code, dialog.fields_dict.dashboard_html.$wrapper.find(`#tab-sales-${unique_id}`), frm.doc.currency);
        } else if (target === `#tab-purchases-${unique_id}` && !purchases_loaded) {
            purchases_loaded = true;
            load_purchase_history(row.item_code, dialog.fields_dict.dashboard_html.$wrapper.find(`#tab-purchases-${unique_id}`), frm.doc.currency);
        }
    });
}

function load_warehouse_stock(frm, item_code, $wrapper) {
    frappe.call({
        method: "purchase_order_customization.api.purchase_order_actions.get_item_warehouse_data",
        args: {
            item_code: item_code,
            company: frm.doc.company
        },
        callback: function (r) {
            $wrapper.empty();
            let data = r.message || [];
            if (!data.length) {
                $wrapper.html(`<div class="text-muted">${__("No stock data found.")}</div>`);
                return;
            }
            let table = `<table class="table table-bordered table-hover">
                <thead>
                    <tr>
                        <th>${__("Warehouse")}</th>
                        <th class="text-right">${__("Actual Qty")}</th>
                        <th class="text-right">${__("Projected Qty")}</th>
                        <th class="text-right">${__("Reserved Qty")}</th>
                    </tr>
                </thead>
                <tbody>`;
            data.forEach(d => {
                table += `<tr>
                    <td><strong>${d.warehouse_name || d.warehouse}</strong></td>
                    <td class="text-right"><span class="badge badge-${d.actual_qty > 0 ? 'success' : 'danger'}">${flt(d.actual_qty)}</span></td>
                    <td class="text-right">${flt(d.projected_qty)}</td>
                    <td class="text-right">${flt(d.reserved_qty)}</td>
                </tr>`;
            });
            table += `</tbody></table>`;
            $wrapper.html(table);
            setup_table_sorting($wrapper.find('table'));
        }
    });
}

function load_sales_history(item_code, $wrapper, currency) {
    let start = 0;
    const limit = 5;

    $wrapper.html(`
        <table class="table table-bordered table-hover sales-table">
            <thead>
                <tr>
                    <th>${__("Date")}</th>
                    <th>${__("Sales Invoice")}</th>
                    <th>${__("Customer")}</th>
                    <th class="text-right">${__("Rate")}</th>
                    <th class="text-right">${__("Qty")}</th>
                    <th>${__("UOM")}</th>
                    <th class="text-right">${__("Amount")}</th>
                </tr>
            </thead>
            <tbody></tbody>
        </table>
        <div class="text-center mt-3 mb-2">
            <button class="btn btn-default btn-sm btn-load-more hidden">${__("Load More")}</button>
        </div>
    `);

    setup_table_sorting($wrapper.find('table'));

    const $tbody = $wrapper.find('tbody');
    const $btn = $wrapper.find('.btn-load-more');

    const fetch_data = () => {
        $btn.prop('disabled', true).text(__("Loading..."));
        frappe.call({
            method: "purchase_order_customization.api.purchase_order_actions.get_item_sales_history",
            args: { item_code: item_code, start: start, limit: limit },
            callback: function (r) {
                let data = r.message || [];
                render_history_rows(data, $tbody, 'sales', currency);
                if (data.length === limit) {
                    $btn.removeClass('hidden').prop('disabled', false).text(__("Load More"));
                    start += limit;
                } else {
                    $btn.addClass('hidden');
                }
                if (start === 0 && data.length === 0) {
                    $tbody.html(`<tr><td colspan="6" class="text-muted text-center">${__("No sales history found.")}</td></tr>`);
                }
            }
        });
    };

    $btn.on('click', fetch_data);
    fetch_data();
}

function load_purchase_history(item_code, $wrapper, currency) {
    let start = 0;
    const limit = 5;

    $wrapper.html(`
        <table class="table table-bordered table-hover purchase-table">
            <thead>
                <tr>
                    <th>${__("Date")}</th>
                    <th>${__("Purchase Invoice")}</th>
                    <th>${__("Supplier")}</th>
                    <th class="text-right">${__("Rate")}</th>
                    <th class="text-right">${__("Qty")}</th>
                    <th>${__("UOM")}</th>
                    <th class="text-right">${__("Amount")}</th>
                </tr>
            </thead>
            <tbody></tbody>
        </table>
        <div class="text-center mt-3 mb-2">
            <button class="btn btn-default btn-sm btn-load-more hidden">${__("Load More")}</button>
        </div>
    `);

    setup_table_sorting($wrapper.find('table'));

    const $tbody = $wrapper.find('tbody');
    const $btn = $wrapper.find('.btn-load-more');

    const fetch_data = () => {
        $btn.prop('disabled', true).text(__("Loading..."));
        frappe.call({
            method: "purchase_order_customization.api.purchase_order_actions.get_item_purchase_history",
            args: { item_code: item_code, start: start, limit: limit },
            callback: function (r) {
                let data = r.message || [];
                render_history_rows(data, $tbody, 'purchase', currency);
                if (data.length === limit) {
                    $btn.removeClass('hidden').prop('disabled', false).text(__("Load More"));
                    start += limit;
                } else {
                    $btn.addClass('hidden');
                }
                if (start === 0 && data.length === 0) {
                    $tbody.html(`<tr><td colspan="6" class="text-muted text-center">${__("No purchase history found.")}</td></tr>`);
                }
            }
        });
    };

    $btn.on('click', fetch_data);
    fetch_data();
}

function render_history_rows(data, $tbody, type, currency) {
    data.forEach(d => {
        let party = type === 'sales' ? d.customer : d.supplier;
        let p_url = type === 'sales' ? `/app/customer/${
party}` : `/app/supplier/${
party}`;
        let doc_url = type === 'sales' ? `/app/sales-invoice/${d.invoice_name}` : `/app/purchase-invoice/${d.invoice_name}`;

        let f_rate = format_currency(d.rate, currency);
        let f_amount = format_currency(d.amount, currency);

        let row_html = `
            <tr>
                <td>${frappe.datetime.str_to_user(d.posting_date)}</td>
                <td><a href="${doc_url}" target="_blank"><strong>${d.invoice_name}</strong></a></td>
                <td><a href="${p_url}" target="_blank">${party}</a></td>
                <td class="text-right" data-value="${flt(d.rate)}">${f_rate}</td>
                <td class="text-right" data-value="${flt(d.qty)}">${flt(d.qty)}</td>
                <td>${d.uom || ''}</td>
                <td class="text-right" data-value="${flt(d.amount)}"><strong>${f_amount}</strong></td>
            </tr>
        `;
        $tbody.append(row_html);
    });
}

// ═══════════════════════════════════════════════════════
//  TABLE SORTING HELPER
// ═══════════════════════════════════════════════════════

function setup_table_sorting($table) {
    $table.find('th').css('cursor', 'pointer').attr('title', __("Click to sort"));
    $table.find('th').on('click', function () {
        const table = $(this).parents('table').eq(0);
        const rows = table.find('tbody tr').toArray().sort(comparer($(this).index()));
        this.asc = !this.asc;
        if (!this.asc) { rows.reverse(); }
        for (let i = 0; i < rows.length; i++) {
            table.find('tbody').append(rows[i]);
        }
    });
}

function comparer(index) {
    return function (a, b) {
        const valA = getCellValue(a, index), valB = getCellValue(b, index);
        return $.isNumeric(valA) && $.isNumeric(valB) ? valA - valB : valA.toString().localeCompare(valB);
    };
}

function getCellValue(row, index) {
    const td = $(row).children('td').eq(index);
    if (td.attr('data-value')) {
        return td.attr('data-value');
    }
    const val = td.text().replace(/[\$,]/g, '');
    return val;
}


function handle_print_purchase_return(frm, returns) {
    if (returns.length === 1) print_return_invoice(frm, returns[0].name);
    else {
        const d = new frappe.ui.Dialog({
            title: __("Select Return to Print"),
            fields: [{ fieldname: "ret", fieldtype: "Select", options: returns.map(r => r.name) }],
            primary_action: (v) => { print_return_invoice(frm, v.ret); d.hide(); }
        });
        d.show();
    }
}

function print_return_invoice(frm, name) {
    frappe.call({
        method: "purchase_order_customization.api.purchase_order_actions.get_purchase_return_print_url",
        args: { invoice_name: name, purchase_order: frm.doc.name },
        callback: (r) => r.message && window.open(r.message.url, "_blank")
    });
}




// --- QUICK ITEM SEARCH (Imported from Purchase Invoice) ---
function remove_rows_without_item_code_po(frm) {
    if (!frm || !frm.doc || !Array.isArray(frm.doc.items) || !frm.doc.items.length) return;
    const rows = (frm.doc.items || []).slice();
    let removed = false;
    rows.forEach((row) => {
        if (row && !row.item_code) {
            frappe.model.clear_doc(row.doctype, row.name);
            removed = true;
        }
    });
    if (removed) frm.refresh_field('items');
}

function toggle_quick_add_visibility_po(frm) {
    if (!frm || !frm.custom_item_search_po) return;
    const has_supplier = !!(frm.doc && frm.doc.supplier);
    const container = frm.custom_item_search_po;
    const body = container.find('.quick-item-search-body');
    const empty = container.find('.quick-item-search-empty');
    if (has_supplier) {
        body.show();
        empty.hide();
        setTimeout(() => {
            const input = document.getElementById('quick_item_search_po');
            if (input) input.focus();
        }, 200);
    } else {
        body.hide();
        empty.show();
    }
}

function add_quick_item_search_po(frm) {
    if (frm.custom_item_search_po) {
        frm.custom_item_search_po.remove();
    }

    const search_html = `
        <div class="quick-item-search" style="margin: 15px 0; padding: 15px; background: #f8f9fa; border-radius: 8px; border: 1px solid #e3e8ef;">
            <div class="quick-item-search-empty" style="display:none; padding: 10px 0;">
                <div class="text-muted" style="display:flex; align-items:center; gap:8px;">
                    <span>${frappe.utils.icon("small-add", "sm")}</span>
                    <span>${__('Select Supplier to enable quick item add')}</span>
                </div>
            </div>
            <div class="quick-item-search-body">
                <div class="form-group" style="margin-bottom: 0;">
                    <div class="control-input-wrapper">
                        <div style="display:flex; gap:8px; align-items:center;">
                        <div class="control-input" style="position: relative; flex:1;">
                            <span style="position:absolute; z-index:2; pointer-events:none; left:12px; top:50%; transform:translateY(-50%); color:#6c757d;">
                                <svg style="width:16px;height:16px;display:block;" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                                    <circle cx="11" cy="11" r="8"></circle>
                                    <path d="m21 21-4.35-4.35"></path>
                                </svg>
                            </span>
                            <input 
                                type="text" 
                                class="input-with-feedback form-control" 
                                id="quick_item_search_po"
                                placeholder="Search item / barcode..."
                                autocomplete="off"
                                style="position: relative; z-index: 1; font-size: 14px; padding: 10px 40px 10px 38px; border: 2px solid #d1d8dd; border-radius: 6px; transition: all 0.2s;"
                            >
                            <div id="search_loading_po" style="
                                position: absolute;
                                right: 12px;
                                top: 50%;
                                transform: translateY(-50%);
                                display: none;
                            ">
                                <svg style="width: 20px; height: 20px; animation: spin 1s linear infinite;" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                                    <path d="M21 12a9 9 0 1 1-6.219-8.56"></path>
                                </svg>
                            </div>
                            <div id="search_results_po" class="search-results-dropdown" style="
                                position: absolute;
                                top: calc(100% + 4px);
                                left: 0;
                                right: 0;
                                background: white;
                                border: 1px solid #d1d8dd;
                                border-radius: 6px;
                                max-height: 450px;
                                overflow-y: auto;
                                display: none;
                                z-index: 1000;
                                box-shadow: 0 8px 16px rgba(0,0,0,0.1);
                            "></div>
                        </div>
                        <button id="quick_add_help_btn_po" type="button" class="btn btn-sm btn-default" style="
                            height: 40px;
                            padding: 0 10px;
                            border-radius: 8px;
                            white-space: nowrap;
                        ">${__('إرشاد')}</button>
                        </div>

                        <div id="quick_add_controls_po" style="margin-top: 10px; display: none;">
                            <div style="display:flex; gap:10px; flex-wrap:wrap; align-items:flex-end; width:100%;">
                                <div style="flex: 0 0 calc(30% - 8px); min-width: 220px;">
                                    <div class="text-muted small" style="margin-bottom:4px;">Selected</div>
                                    <input id="quick_add_selected_po" class="form-control input-sm" readonly style="height:34px; font-weight:600; background:#fff;">
                                </div>
                                <div style="flex: 0 0 calc(10% - 8px); min-width: 80px;">
                                    <label class="text-muted small" style="margin-bottom:4px; display:block;">Qty</label>
                                    <input id="quick_add_qty_po" type="number" class="form-control input-sm" value="1" min="0" step="1" style="height:34px;">
                                </div>
                                <div style="flex: 0 0 calc(12% - 8px); min-width: 110px;">
                                    <label class="text-muted small" style="margin-bottom:4px; display:block;">UOM</label>
                                    <div style="position:relative;">
                                        <input id="quick_add_uom_po" class="form-control input-sm" placeholder="UOM" style="height:34px;">
                                        <div id="quick_add_uom_results_po" style="
                                            position: absolute;
                                            top: calc(100% + 4px);
                                            left: 0;
                                            right: 0;
                                            background: white;
                                            border: 1px solid #d1d8dd;
                                            border-radius: 6px;
                                            max-height: 220px;
                                            overflow-y: auto;
                                            display: none;
                                            z-index: 1100;
                                            box-shadow: 0 8px 16px rgba(0,0,0,0.1);
                                        "></div>
                                    </div>
                                </div>
                                <div style="flex: 0 0 calc(12% - 8px); min-width: 110px;">
                                    <label class="text-muted small" style="margin-bottom:4px; display:block;">Rate</label>
                                    <input id="quick_add_rate_po" type="number" class="form-control input-sm" placeholder="auto" step="0.01" style="height:34px;">
                                </div>
                                <div style="flex: 0 0 calc(12% - 8px); min-width: 110px;">
                                    <label class="text-muted small" style="margin-bottom:4px; display:block;">Last Price</label>
                                    <input id="quick_add_last_price_po" class="form-control input-sm" readonly style="height:34px; background:#fff3cd; color:#856404; font-weight:600;" value="-">
                                </div>
                                <div style="flex: 0 0 calc(12% - 8px); min-width: 130px; display:flex; gap:8px; align-items:flex-end; justify-content:flex-end;">
                                    <button id="quick_add_btn_po" class="btn btn-primary btn-sm" type="button" style="height:34px;">Add</button>
                                    <button id="quick_add_details_btn_po" class="btn btn-default btn-sm" type="button" style="height:34px; display:none;">Details</button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
        <style>
            @keyframes spin { to { transform: rotate(360deg); } }
            #quick_item_search_po:focus {
                border-color: #2490ef !important;
                box-shadow: 0 0 0 3px rgba(36, 144, 239, 0.1) !important;
                outline: none;
            }
            .search-result-item { transition: all 0.15s ease; }
            .search-result-item:hover { background: #f0f4ff !important; transform: translateX(2px); }
            .search-result-item.selected { background: #e8f5e9 !important; }
        </style>
    `;

    frm.custom_item_search_po = $(search_html).insertBefore(frm.fields_dict.items.wrapper);
    toggle_quick_add_visibility_po(frm);
    setup_autocomplete_po(frm);
}

// -----------------------------
// Offline items sync (reuse Sales Invoice sync if available)
// -----------------------------

function add_offline_items_sync_button_po(frm) {
    if (frm.doc.docstatus !== 0) return;
    frm.add_custom_button(__('Sync Items Offline'), function() {
        sync_all_items_offline_po(frm, { force: true });
    }, __('Get Items'));
    sync_all_items_offline_po(frm, { force: false });
}

function compute_initials_po(name) {
    if (!name) return '';
    return String(name)
        .trim()
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean)
        .map(w => w[0])
        .join('');
}

function tokenize_words_lower_po(s) {
    return String(s || '')
        .trim()
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean);
}

async function offline_items_put_many_po(db, items) {
    if (!db) return;
    await new Promise((resolve) => {
        const tx = db.transaction('items', 'readwrite');
        const os = tx.objectStore('items');
        (items || []).forEach((it) => os.put(it));
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
    });
}

async function offline_uoms_put_many_po(db, rows) {
    if (!db) return;
    await new Promise((resolve) => {
        const tx = db.transaction('item_uoms', 'readwrite');
        const os = tx.objectStore('item_uoms');
        (rows || []).forEach((r) => os.put(r));
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
    });
}

async function sync_all_items_offline_po(frm, { force }) {
    if (typeof sync_all_items_offline === 'function') {
        await sync_all_items_offline(frm, { force });
        return;
    }

    const last_sync = parseInt(localStorage.getItem('dr_offline_items_last_sync_ts') || '0', 10);
    const now = Date.now();
    const sync_interval_ms = 6 * 60 * 60 * 1000;
    if (!force && last_sync && (now - last_sync) < sync_interval_ms) return;

    const db = await open_offline_items_db_po();
    if (!db) {
        frappe.show_alert({ message: __('IndexedDB not available; offline sync disabled'), indicator: 'orange' }, 6);
        return;
    }

    frappe.show_alert({ message: __('Syncing all items for offline search...'), indicator: 'blue' }, 6);

    let after_modified = null;
    let after_name = null;
    let total = 0;

    while (true) {
        // eslint-disable-next-line no-await-in-loop
        const r = await new Promise((resolve) => {
            frappe.call({
                method: 'dr.api.item_search.sync_items_minimal',
                args: {
                    after_modified: after_modified,
                    after_name: after_name,
                    limit: 2000
                },
                callback: function(res) { resolve(res); },
                error: function(err) { resolve({ error: err }); }
            });
        });

        if (r && r.error) {
            frappe.show_alert({ message: __('Offline sync failed (network/server). Try again.'), indicator: 'red' }, 6);
            break;
        }

        const payload = r && r.message;
        const batch = (payload && payload.items) || [];
        if (!batch.length) break;

        const to_store = batch.map((row) => {
            const code = row.item_code || row.name || '';
            const name = row.item_name || '';
            const barcode = row.barcode || '';
            const name_words = tokenize_words_lower_po(name);
            return {
                name: row.name,
                item_code: code,
                item_name: name,
                stock_uom: row.stock_uom || '',
                barcode: barcode,
                modified: row.modified,
                item_code_lower: String(code).toLowerCase(),
                item_name_lower: String(name).toLowerCase(),
                barcode_lower: String(barcode).toLowerCase(),
                item_name_words: name_words,
                initials: compute_initials_po(name)
            };
        });

        // eslint-disable-next-line no-await-in-loop
        await offline_items_put_many_po(db, to_store);
        total += to_store.length;
        frappe.show_alert({ message: __('Synced {0} items...', [total]), indicator: 'blue' }, 2);

        if (!payload.has_more) break;
        after_modified = payload.next_after_modified;
        after_name = payload.next_after_name;
    }

    localStorage.setItem('dr_offline_items_last_sync_ts', String(Date.now()));
    frappe.show_alert({ message: __('Offline items sync complete ({0} items)', [total]), indicator: 'green' }, 6);

    let u_after_parent = null;
    let u_after_uom = null;
    let u_total = 0;

    frappe.show_alert({ message: __('Syncing item UOMs...'), indicator: 'blue' }, 4);
    while (true) {
        // eslint-disable-next-line no-await-in-loop
        const r2 = await new Promise((resolve) => {
            frappe.call({
                method: 'dr.api.item_search.sync_item_uoms',
                args: {
                    after_parent: u_after_parent,
                    after_uom: u_after_uom,
                    limit: 8000
                },
                callback: function(res) { resolve(res); },
                error: function(err) { resolve({ error: err }); }
            });
        });

        if (r2 && r2.error) {
            frappe.show_alert({ message: __('UOM sync failed (network/server).'), indicator: 'orange' }, 5);
            break;
        }

        const payload2 = r2 && r2.message;
        const batch2 = (payload2 && payload2.rows) || [];
        if (!batch2.length) break;

        const to_store2 = batch2.map((row) => ({
            key: `${row.parent}|${row.uom}`,
            parent: row.parent,
            uom: row.uom,
            conversion_factor: row.conversion_factor
        }));

        // eslint-disable-next-line no-await-in-loop
        await offline_uoms_put_many_po(db, to_store2);
        u_total += to_store2.length;
        frappe.show_alert({ message: __('Synced {0} UOM rows...', [u_total]), indicator: 'blue' }, 2);

        if (!payload2.has_more) break;
        u_after_parent = payload2.next_after_parent;
        u_after_uom = payload2.next_after_uom;
    }

    frappe.show_alert({ message: __('Offline sync ready (items + UOMs)'), indicator: 'green' }, 4);
}

// Uses the same IndexedDB stores created by Sales Invoice script (dr_offline_items)
async function open_offline_items_db_po() {
    // reuse function if already loaded by another script
    if (typeof open_offline_items_db === 'function') return await open_offline_items_db();
    // fallback: open directly
    const DB_NAME = 'dr_offline_items';
    const DB_VERSION = 2;
    if (typeof indexedDB === 'undefined') return null;
    return await new Promise((resolve) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onsuccess = function() { resolve(req.result); };
        req.onerror = function() { resolve(null); };
        req.onupgradeneeded = function() { resolve(req.result); };
    });
}

async function offline_items_load_all_po(db) {
    if (!db) return [];
    return await new Promise((resolve) => {
        const tx = db.transaction('items', 'readonly');
        const os = tx.objectStore('items');
        const req = os.getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
    });
}

async function offline_uoms_get_for_item_po(item_code) {
    // reuse if exists
    if (typeof offline_uoms_get_for_item === 'function') return await offline_uoms_get_for_item(item_code);
    const db = await open_offline_items_db_po();
    if (!db) return [];
    return await new Promise((resolve) => {
        const tx = db.transaction('item_uoms', 'readonly');
        const os = tx.objectStore('item_uoms');
        const idx = os.index('parent');
        const req = idx.getAll(String(item_code || '').trim());
        req.onsuccess = () => resolve((req.result || []).map(r => r.uom).filter(Boolean));
        req.onerror = () => resolve([]);
    });
}

let DR_OFFLINE_ITEMS_PO = { loaded: false, items: [] };

async function ensure_offline_items_loaded_po() {
    if (DR_OFFLINE_ITEMS_PO.loaded) return true;
    const db = await open_offline_items_db_po();
    if (!db) return false;
    const all = await offline_items_load_all_po(db);
    DR_OFFLINE_ITEMS_PO.items = all || [];
    DR_OFFLINE_ITEMS_PO.loaded = true;
    return true;
}

function search_items_offline_po(query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q || q.length < 2) return [];

    const tokens = q.split(/\s+/).filter(Boolean);
    const is_multi_token = tokens.length >= 2;
    const are_short_tokens = is_multi_token && tokens.every(t => t.length <= 12);

    const exact_code = [];
    const barcode_exact = [];
    const code_starts = [];
    const name_starts = [];
    const ordered_prefix = [];
    const contains = [];

    // Local helpers (same logic as Sales Invoice)
    const tokenize_words_lower_local = (s) =>
        String(s || '')
            .trim()
            .toLowerCase()
            .split(/\s+/)
            .filter(Boolean);

    const ordered_word_prefix_match_local = (item_words, toks) => {
        if (!Array.isArray(item_words) || !item_words.length) return false;
        if (!Array.isArray(toks) || toks.length < 2) return false;
        let j = 0;
        for (let i = 0; i < item_words.length && j < toks.length; i++) {
            if (item_words[i].startsWith(toks[j])) j++;
        }
        return j === toks.length;
    };

    for (let i = 0; i < DR_OFFLINE_ITEMS_PO.items.length; i++) {
        const it = DR_OFFLINE_ITEMS_PO.items[i];
        const code = (it.item_code_lower || '').toLowerCase();
        const name = (it.item_name_lower || '').toLowerCase();
        const barcode = (it.barcode_lower || '').toLowerCase();
        const words = Array.isArray(it.item_name_words) ? it.item_name_words : tokenize_words_lower_local(name);

        let matched = false;

        if (code === q) {
            matched = true;
            exact_code.push(it);
        } else if (barcode && barcode === q) {
            matched = true;
            barcode_exact.push(it);
        } else if (code.startsWith(q)) {
            matched = true;
            code_starts.push(it);
        } else if (name.startsWith(q)) {
            matched = true;
            name_starts.push(it);
        } else if (are_short_tokens && ordered_word_prefix_match_local(words, tokens)) {
            matched = true;
            ordered_prefix.push(it);
        } else if (code.includes(q) || name.includes(q) || (barcode && barcode.includes(q))) {
            matched = true;
            contains.push(it);
        } else if (are_short_tokens && is_multi_token) {
            const all_match = tokens.every(t => code.includes(t) || name.includes(t) || (barcode && barcode.includes(t)));
            if (all_match) {
                matched = true;
                contains.push(it);
            }
        }

        if (matched) {
            const total =
                exact_code.length +
                barcode_exact.length +
                code_starts.length +
                name_starts.length +
                ordered_prefix.length +
                contains.length;
            if (total >= 50) break;
        }
    }

    return []
        .concat(exact_code, barcode_exact, code_starts, name_starts, ordered_prefix, contains)
        .slice(0, 50)
        .map((it) => ({
            item_code: it.item_code,
            item_name: it.item_name,
            stock_uom: it.stock_uom,
            barcode: it.barcode || ''
        }));
}

function show_po_item_details_popup(frm, item) {
    if (!item || !item.item_code) return;
    if (!frm.doc.supplier) {
        frappe.msgprint(__('Please select Supplier first.'));
        return;
    }

    const d = new frappe.ui.Dialog({
        title: __('Purchase Rate History'),
        size: 'large',
        fields: [{ fieldtype: 'HTML', fieldname: 'content' }]
    });
    d.fields_dict.content.$wrapper.html(`
        <div style="display:flex; justify-content:space-between; gap:10px; flex-wrap:wrap;">
            <div><b>${__('Item')}:</b> ${frappe.utils.escape_html(item.item_code)} - ${frappe.utils.escape_html(item.item_name || '')}</div>
            <div class="text-muted">${__('Loading...')}</div>
        </div>
        <div id="dr_pi_popup_table_wrap" style="margin-top:10px;"></div>
        <div style="display:flex; justify-content:flex-end; margin-top:10px;">
            <button class="btn btn-sm btn-secondary" id="dr_pi_popup_load_more" style="display:none;">${__('Load more')}</button>
        </div>
    `);
    d.show();

    const $wrap = d.fields_dict.content.$wrapper;
    const $table_wrap = $wrap.find('#dr_pi_popup_table_wrap');
    const $load_more = $wrap.find('#dr_pi_popup_load_more');
    let next_offset = 0;

    function ensure_table() {
        if ($table_wrap.find('table').length) return;
        $table_wrap.html(`
            <table class="table table-bordered" style="margin-top:10px;">
                <thead>
                    <tr>
                        <th>${__('Date')}</th>
                        <th>${__('Rate')}</th>
                        <th>${__('Qty')}</th>
                        <th>${__('UOM')}</th>
                        <th>${__('Invoice')}</th>
                    </tr>
                </thead>
                <tbody id="dr_pi_popup_tbody"></tbody>
            </table>
        `);
    }

    function append_rows(rows) {
        if (!rows || !rows.length) return;
        ensure_table();
        const $tbody = $table_wrap.find('#dr_pi_popup_tbody');
        $tbody.append(rows.map(x => `
            <tr>
                <td>${frappe.datetime.str_to_user(x.posting_date)}</td>
                <td>${format_number(x.rate || 0, null, 2)} ${frappe.utils.escape_html(x.currency || '')}</td>
                <td>${format_number(x.qty || 0, null, 2)}</td>
                <td>${frappe.utils.escape_html(x.uom || '')}</td>
                <td><a href="/app/purchase-invoice/${encodeURIComponent(x.purchase_invoice)}" target="_blank">${frappe.utils.escape_html(x.purchase_invoice)}</a></td>
            </tr>
        `).join(''));
    }

    function load_page() {
        $load_more.prop('disabled', true).text(__('Loading...')).show();
        frappe.call({
            method: 'dr.api.item_search.get_supplier_item_rate_history_page',
            args: {
                supplier: frm.doc.supplier,
                item_code: item.item_code,
                limit: 5,
                offset: next_offset
            },
            callback: function(r) {
                const data = r.message || {};
                const rows = data.history || [];
                if (next_offset === 0 && (!rows || !rows.length)) {
                    $table_wrap.html(`<div class="text-muted" style="margin-top:10px;">${__('No previous purchases for this supplier/item.')}</div>`);
                    $load_more.hide();
                    return;
                }
                append_rows(rows);
                next_offset = data.next_offset || (next_offset + rows.length);
                if (data.has_more) {
                    $load_more.prop('disabled', false).text(__('Load more')).show();
                } else {
                    $load_more.hide();
                }
            }
        });
    }

    $load_more.on('click', load_page);
    load_page();
}

function attach_items_grid_details_buttons_po(frm) {
    const grid = frm.fields_dict.items && frm.fields_dict.items.grid;
    if (!grid || !grid.grid_rows) return;

    if (!frm.wrapper._dr_pi_grid_row_render_bound) {
        frm.wrapper._dr_pi_grid_row_render_bound = true;
        $(frm.wrapper).on('grid-row-render', function(_e, grid_row) {
            if (!grid_row || !grid_row.doc || !grid_row.wrapper) return;
            if (grid_row.doc.parentfield !== 'items' || grid_row.doc.parenttype !== 'Purchase Order') return;
            const gr = grid_row;
            gr.wrapper.find('.dr-pi-details-btn').remove();
            if (!gr.doc.item_code) return;
            const action_col = gr.wrapper.find('.btn-open-row').closest('.col');
            const target = (action_col && action_col.length) ? action_col : gr.wrapper.find('.data-row .col:last');
            if (!target || !target.length) return;
            target.css({ display: 'flex', gap: '6px', justifyContent: 'center', alignItems: 'center' });
            target.append(`
                <div class="btn-open-row dr-pi-details-btn" data-docname="${frappe.utils.escape_html(gr.doc.name)}"
                     title="${__('Details')}" style="display:inline-flex;" data-toggle="tooltip" data-placement="right">
                    <a>${frappe.utils.icon("link-url", "sm")}</a>
                </div>
            `);
        });
    }

    if (!grid.wrapper.data('dr_pi_details_bound')) {
        grid.wrapper.data('dr_pi_details_bound', true);
        grid.wrapper.on('click', '.dr-pi-details-btn', function(e) {
            e.preventDefault();
            e.stopPropagation();
            const docname = $(this).attr('data-docname');
            const row = (frm.doc.items || []).find(r => r && r.name === docname);
            if (row && row.item_code) {
                show_po_item_details_popup(frm, { item_code: row.item_code, item_name: row.item_name });
            }
        });
    }
}

function setup_autocomplete_po(frm) {
    const input = document.getElementById('quick_item_search_po');
    const results_div = document.getElementById('search_results_po');
    const loading_icon = document.getElementById('search_loading_po');
    const controls_div = document.getElementById('quick_add_controls_po');
    const selected_input = document.getElementById('quick_add_selected_po');
    const qty_input = document.getElementById('quick_add_qty_po');
    const uom_input = document.getElementById('quick_add_uom_po');
    const uom_results = document.getElementById('quick_add_uom_results_po');
    const rate_input = document.getElementById('quick_add_rate_po');
    const last_price_input = document.getElementById('quick_add_last_price_po');
    const add_btn = document.getElementById('quick_add_btn_po');
    const details_btn = document.getElementById('quick_add_details_btn_po');
    const help_btn = document.getElementById('quick_add_help_btn_po');

    let search_timeout = null;
    let selected_index = -1;
    let items_list = [];
    let current_search = '';
    let add_in_progress = false;
    let pending_item = null;
    let uom_options = [];
    let uom_selected_index = -1;

    function show_controls(show) {
        if (!controls_div) return;
        controls_div.style.display = show ? 'block' : 'none';
    }

    function clear_controls() {
        pending_item = null;
        if (selected_input) selected_input.value = '';
        if (qty_input) qty_input.value = '1';
        if (uom_input) uom_input.value = '';
        if (uom_input) { uom_input.readOnly = false; uom_input.disabled = false; }
        if (rate_input) rate_input.value = '';
        if (last_price_input) last_price_input.value = '-';
        if (uom_results) { uom_results.innerHTML = ''; uom_results.style.display = 'none'; }
        if (details_btn) details_btn.style.display = 'none';
        uom_options = [];
        uom_selected_index = -1;
        show_controls(false);
    }

    function fetch_and_display_last_price_po(item_code, uom) {
        if (!last_price_input) return;
        if (!frm.doc.supplier || !item_code) {
            last_price_input.value = '-';
            return;
        }
        frappe.call({
            method: 'purchase_order_customization.api.purchase_order_actions.get_last_purchase_rate',
            args: { supplier: frm.doc.supplier, item_code: item_code, uom: uom || '' },
            async: true,
            callback: function(r) {
                if (r.message && flt(r.message) > 0) {
                    last_price_input.value = format_number(flt(r.message), null, 2);
                } else {
                    last_price_input.value = '-';
                }
            }
        });
    }

    function hide_uom_dropdown() {
        if (!uom_results) return;
        uom_results.style.display = 'none';
        uom_selected_index = -1;
    }

    function highlight_uom_selected() {
        if (!uom_results) return;
        uom_results.querySelectorAll('.uom-result-item').forEach((el, idx) => {
            el.style.background = (idx === uom_selected_index) ? '#e8f5e9' : 'white';
        });
    }

    function render_uom_dropdown(filter_text) {
        if (!uom_results || !uom_input) return;
        if (uom_input.disabled || uom_input.readOnly) { hide_uom_dropdown(); return; }
        const f = String(filter_text || '').toLowerCase();
        const list = (uom_options || []).filter(u => !f || String(u).toLowerCase().includes(f));
        if (!list.length) { uom_results.style.display = 'none'; return; }
        uom_results.innerHTML = list.map((u, idx) => `
            <div class="uom-result-item" data-index="${idx}" style="padding:8px 10px; border-bottom:1px solid #f0f0f0; cursor:pointer; font-size:13px;">
                ${frappe.utils.escape_html(String(u))}
            </div>
        `).join('');
        uom_results.style.display = 'block';
        uom_selected_index = 0;
        highlight_uom_selected();
        uom_results.querySelectorAll('.uom-result-item').forEach((el) => {
            el.addEventListener('mouseenter', function() {
                uom_selected_index = parseInt(this.dataset.index);
                highlight_uom_selected();
            });
            el.addEventListener('click', function() {
                const idx = parseInt(this.dataset.index);
                uom_input.value = list[idx];
                hide_uom_dropdown();
                if (pending_item) fetch_and_display_last_price_po(pending_item.item_code, list[idx]);
                setTimeout(() => rate_input && rate_input.focus(), 10);
            });
        });
    }

    async function populate_uoms_for_item(item_code) {
        const uoms = await offline_uoms_get_for_item_po(item_code);
        const unique = new Set((uoms || []).filter(Boolean));
        uom_options = [...unique].slice(0, 200);
        uom_selected_index = -1;
        if (uom_input) {
            if (uom_options.length === 1) {
                uom_input.value = uom_options[0];
                uom_input.readOnly = true;
            } else {
                uom_input.readOnly = false;
            }
        }
    }

    async function prepare_item_for_add(item) {
        if (!item || !item.item_code) return;
        pending_item = item;
        // Reset controls for the newly selected item (so rate/uom always refresh)
        if (qty_input) qty_input.value = '1';
        if (uom_input && !uom_input.readOnly) uom_input.value = '';
        if (rate_input) rate_input.value = '';
        if (last_price_input) last_price_input.value = '-';
        if (selected_input) selected_input.value = `${item.item_code} - ${item.item_name || ''}`.trim();
        show_controls(true);
        if (results_div) results_div.style.display = 'none';
        if (details_btn) details_btn.style.display = 'inline-block';

        await populate_uoms_for_item(item.item_code);
        if (uom_input && !uom_input.value && item.stock_uom) uom_input.value = item.stock_uom;

        // Fetch last price for this item + UOM
        fetch_and_display_last_price_po(item.item_code, uom_input?.value || item.stock_uom);

        setTimeout(() => qty_input && qty_input.focus(), 20);
        setTimeout(() => qty_input && qty_input.select && qty_input.select(), 30);
    }

    function show_selected_item_details() {
        if (!pending_item || !pending_item.item_code) return;
        show_po_item_details_popup(frm, pending_item);
    }

    function commit_pending_add() {
        if (!pending_item) return;
        const qty = parseFloat(qty_input?.value || '1') || 1;
        const uom = String(uom_input?.value || '').trim();
        const rate_str = String(rate_input?.value || '').trim();
        const rate = rate_str ? parseFloat(rate_str) : null;
        // Read last price from the search bar (read-only field)
        const lp_str = String(last_price_input?.value || '').trim();
        const last_price = (lp_str && lp_str !== '-') ? parseFloat(lp_str.replace(/,/g, '')) : null;
        add_item_to_table_po(frm, pending_item, { qty, uom: uom || null, rate, last_price: last_price });
        clear_controls();
        input.value = '';
        results_div.style.display = 'none';
        setTimeout(() => input.focus(), 30);
    }

    if (add_btn) add_btn.addEventListener('click', commit_pending_add);
    if (details_btn) details_btn.addEventListener('click', show_selected_item_details);
    if (help_btn) {
        help_btn.addEventListener('click', function() {
            frappe.msgprint({
                title: __('إرشادات البحث السريع'),
                message: `
                    <div style="line-height:1.9">
                        <div><b>1)</b> اختر <b>المورد</b> أولاً ليظهر البحث السريع.</div>
                        <div><b>2)</b> اكتب 2+ أحرف ثم <b>Enter</b> لاختيار أول صنف (لن تتم الإضافة بعد).</div>
                        <div><b>3)</b> استخدم <b>Tab</b> للتنقل بين: الكمية → الوحدة → السعر → إضافة → التفاصيل.</div>
                        <div><b>4)</b> اضغط <b>Enter</b> داخل (الكمية/الوحدة/السعر) لإضافة الصنف للجدول.</div>
                        <div><b>5)</b> السعر لا يتم حسابه في الحقل هنا لتسريع الأداء — سيظهر في الجدول بعد الإضافة.</div>
                        <div><b>6)</b> اختصار: داخل (الكمية/الوحدة/السعر) اضغط <b>Alt</b> لفتح نافذة التفاصيل.</div>
                        <div class="text-muted" style="margin-top:8px;">للبحث بدون إنترنت: افتح Sales Invoice واضغط <b>Sync Items Offline</b> مرة واحدة.</div>
                    </div>
                `,
                indicator: 'blue'
            });
        });
    }

    [qty_input, uom_input, rate_input].forEach((el) => {
        if (!el) return;
        el.addEventListener('keydown', function(e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                commit_pending_add();
            } else if (e.key === 'Alt') {
                e.preventDefault();
                show_selected_item_details();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                clear_controls();
                setTimeout(() => input.focus(), 30);
            }
        });
    });

    if (uom_input) {
        uom_input.addEventListener('focus', function() { render_uom_dropdown(uom_input.value); });
        uom_input.addEventListener('input', function() { render_uom_dropdown(uom_input.value); });
        uom_input.addEventListener('keydown', function(e) {
            if (!uom_results || uom_results.style.display === 'none') return;
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                uom_selected_index = Math.min(uom_selected_index + 1, (uom_results.querySelectorAll('.uom-result-item').length - 1));
                highlight_uom_selected();
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                uom_selected_index = Math.max(uom_selected_index - 1, 0);
                highlight_uom_selected();
            } else if (e.key === 'Enter') {
                e.preventDefault();
                const els = uom_results.querySelectorAll('.uom-result-item');
                const el = els[uom_selected_index];
                if (el) {
                    uom_input.value = el.textContent.trim() || '';
                    hide_uom_dropdown();
                    if (pending_item) fetch_and_display_last_price_po(pending_item.item_code, uom_input.value);
                    setTimeout(() => rate_input && rate_input.focus(), 10);
                }
            } else if (e.key === 'Escape') {
                e.preventDefault();
                hide_uom_dropdown();
            }
        });
    }

    document.addEventListener('click', function(e) {
        if (uom_input && uom_results && !uom_input.contains(e.target) && !uom_results.contains(e.target)) {
            hide_uom_dropdown();
        }
    });

    input._dr_set_add_in_progress = function(v) { add_in_progress = !!v; };

    input.addEventListener('input', function(e) {
        const search_text = e.target.value.trim();
        current_search = search_text;
        clearTimeout(search_timeout);
        if (pending_item) clear_controls();

        if (search_text.length < 2) {
            results_div.style.display = 'none';
            if (loading_icon) loading_icon.style.display = 'none';
            return;
        }
        if (loading_icon) loading_icon.style.display = 'block';

        search_timeout = setTimeout(async function() {
            if (!(await ensure_offline_items_loaded_po())) {
                if (loading_icon) loading_icon.style.display = 'none';
                results_div.innerHTML = `<div style="padding:12px; color:#888;">${__('Offline items not synced yet. Open Sales Invoice and Sync Items Offline first.')}</div>`;
                results_div.style.display = 'block';
                return;
            }
            const items = search_items_offline_po(search_text);
            if (current_search === search_text) {
                if (loading_icon) loading_icon.style.display = 'none';
                display_results(items);
            }
        }, 250);
    });

    input.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            if (add_in_progress) return;
            const to_prepare =
                (selected_index >= 0 && items_list[selected_index]) ? items_list[selected_index] :
                (items_list.length > 0 ? items_list[0] : null);
            if (to_prepare) {
                prepare_item_for_add(to_prepare);
                return;
            }
        } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            selected_index = Math.min(selected_index + 1, items_list.length - 1);
            highlight_selected();
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            selected_index = Math.max(selected_index - 1, -1);
            highlight_selected();
        } else if (e.key === 'Escape') {
            results_div.style.display = 'none';
            selected_index = -1;
        } else if (e.key === 'Tab') {
            if (items_list.length > 0) {
                e.preventDefault();
                const to_prepare = (selected_index >= 0 && items_list[selected_index]) ? items_list[selected_index] : items_list[0];
                prepare_item_for_add(to_prepare);
            }
        }
    });

    function display_results(items) {
        items_list = items || [];
        selected_index = -1;
        if (!items_list.length) {
            results_div.innerHTML = `<div style="padding:12px; color:#888; text-align:center;">${__('No items found')}</div>`;
            results_div.style.display = 'block';
            return;
        }
        results_div.innerHTML = items_list.slice(0, 30).map((it, idx) => `
            <div class="search-result-item ${idx===0?'selected':''}" data-index="${idx}" style="padding:10px 12px; border-bottom:1px solid #f0f0f0; cursor:pointer;">
                <div style="font-weight:600;">${frappe.utils.escape_html(it.item_code)}</div>
                <div class="text-muted small">${frappe.utils.escape_html(it.item_name || '')}</div>
            </div>
        `).join('');
        results_div.style.display = 'block';
        selected_index = 0;

        results_div.querySelectorAll('.search-result-item').forEach((elem) => {
            elem.addEventListener('mouseenter', function() {
                selected_index = parseInt(this.dataset.index);
                highlight_selected();
            });
            elem.addEventListener('click', function() {
                const index = parseInt(this.dataset.index);
                prepare_item_for_add(items_list[index]);
            });
        });
    }

    function highlight_selected() {
        results_div.querySelectorAll('.search-result-item').forEach((elem, idx) => {
            elem.style.background = (idx === selected_index) ? '#e8f5e9' : 'white';
        });
    }
}

let DR_PI_RECALC_TIMER = null;
function schedule_recalculate_po(frm) {
    clearTimeout(DR_PI_RECALC_TIMER);
    DR_PI_RECALC_TIMER = setTimeout(() => frm.script_manager.trigger('calculate_taxes_and_totals'), 200);
}

function add_item_to_table_po(frm, item, opts) {
    if (!item || !item.item_code) return;
    opts = opts || {};
    if (frm.doc.docstatus !== 0) {
        frappe.msgprint(__('Cannot add items to submitted Purchase Order'));
        return;
    }

    // Show lightweight loading
    const input = document.getElementById('quick_item_search_po');
    const loading_icon = document.getElementById('search_loading_po');
    if (input && input._dr_set_add_in_progress) input._dr_set_add_in_progress(true);
    if (loading_icon) loading_icon.style.display = 'block';

    const target_uom = opts.uom || item.stock_uom || '';
    const has_custom_rate = opts.rate !== undefined && opts.rate !== null && opts.rate !== '' && !Number.isNaN(opts.rate);

    // Check if item already exists with the SAME UOM → just increment qty
    let existing_row = null;
    (frm.doc.items || []).forEach(row => {
        if (row.item_code === item.item_code && (!target_uom || row.uom === target_uom)) {
            existing_row = row;
        }
    });

    if (existing_row) {
        // Existing row: bump qty and set rate priority: custom rate > last price > keep existing
        const new_qty = existing_row.qty + (opts.qty || 1);
        const has_last_price = opts.last_price !== undefined && opts.last_price !== null && !Number.isNaN(opts.last_price) && opts.last_price > 0;
        let effective_rate = existing_row.rate; // default: keep existing rate
        if (has_custom_rate) {
            effective_rate = opts.rate;
        } else if (has_last_price) {
            effective_rate = opts.last_price;
        }
        frappe.model.set_value(existing_row.doctype, existing_row.name, 'qty', new_qty);
        frappe.model.set_value(existing_row.doctype, existing_row.name, 'rate', effective_rate);
        frappe.model.set_value(existing_row.doctype, existing_row.name, 'amount',
            new_qty * flt(effective_rate));
        frm.refresh_field('items');
        schedule_recalculate_po(frm);
        if (loading_icon) loading_icon.style.display = 'none';
        if (input && input._dr_set_add_in_progress) input._dr_set_add_in_progress(false);
        return;
    }

    // New row: single backend call to get all item details
    frappe.call({
        method: 'purchase_order_customization.api.purchase_order_actions.get_item_details_for_purchase_order',
        args: {
            item_code: item.item_code,
            company: frm.doc.company,
            supplier: frm.doc.supplier || '',
            currency: frm.doc.currency || '',
            price_list: frm.doc.buying_price_list || '',
            qty: opts.qty || 1,
            uom: target_uom,
            warehouse: frm.doc.set_warehouse || '',
            conversion_rate: frm.doc.conversion_rate || 1,
            transaction_date: frm.doc.transaction_date || frm.doc.schedule_date || '',
            ignore_pricing_rule: frm.doc.ignore_pricing_rule || 0,
        },
        async: true,
        callback: function (r) {
            try {
                if (!r || !r.message) {
                    frappe.show_alert({ message: __('Could not fetch item details'), indicator: 'red' }, 3);
                    return;
                }

                const details = r.message;
                const child_doctype = (frm.fields_dict.items && frm.fields_dict.items.grid && frm.fields_dict.items.grid.doctype)
                    ? frm.fields_dict.items.grid.doctype
                    : 'Purchase Order Item';
                const row = frappe.model.add_child(frm.doc, child_doctype, 'items', 1);

                // Populate all fields directly from backend response
                const fields_to_set = [
                    'item_code', 'item_name', 'description', 'image',
                    'uom', 'stock_uom', 'conversion_factor',
                    'warehouse', 'expense_account', 'cost_center',
                    'price_list_rate', 'base_price_list_rate',
                    'discount_percentage', 'discount_amount',
                    'rate', 'base_rate', 'net_rate',
                    'item_tax_template', 'item_tax_rate',
                    'item_group', 'brand',
                    'has_serial_no', 'has_batch_no',
                    'weight_per_unit', 'weight_uom', 'total_weight',
                    'last_purchase_rate',
                ];

                fields_to_set.forEach(field => {
                    if (details[field] !== undefined && details[field] !== null) {
                        row[field] = details[field];
                    }
                });

                // Set qty and compute amounts
                row.qty = flt(opts.qty || 1);
                row.stock_qty = flt(row.qty) * flt(row.conversion_factor || 1);

                // Rate priority: custom rate from search bar > backend rate
                if (has_custom_rate) {
                    row.rate = flt(opts.rate);
                } else {
                    row.rate = flt(details.rate || details.price_list_rate || 0);
                }
                row.price_list_rate = flt(details.price_list_rate || row.rate);
                row.amount = flt(row.qty * row.rate);
                row.base_rate = flt(row.rate * (frm.doc.conversion_rate || 1));
                row.base_amount = flt(row.amount * (frm.doc.conversion_rate || 1));
                row.net_rate = row.rate;
                row.net_amount = row.amount;

                // Set custom_last_rate from backend
                row.custom_last_rate = flt(details.custom_last_rate || 0);

                // Set schedule_date from parent
                row.schedule_date = frm.doc.schedule_date || '';

                frm.refresh_field('items');
                schedule_recalculate_po(frm);

            } finally {
                if (loading_icon) loading_icon.style.display = 'none';
                if (input && input._dr_set_add_in_progress) input._dr_set_add_in_progress(false);
            }
        },
        error: function () {
            if (loading_icon) loading_icon.style.display = 'none';
            if (input && input._dr_set_add_in_progress) input._dr_set_add_in_progress(false);
            frappe.show_alert({ message: __('Error fetching item details'), indicator: 'red' }, 3);
        }
    });
}
