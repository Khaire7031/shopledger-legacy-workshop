const assert = require('node:assert/strict');
const { once } = require('node:events');
const { test } = require('node:test');

const app = require('../server');
const invoice = require('../lib/invoice');
const pricing = require('../lib/pricing');
const reports = require('../lib/reports');
const store = require('../lib/store');

test('invoice applies a normalized coupon before calculating each GST slab', function () {
  const items = [
    { name: 'Rice', hsn: '1006', price: 400, qty: 1 },
    { name: 'Tea', hsn: '0902', price: 200, qty: 1 }
  ];
  const figures = invoice.computeInvoiceFigures({ items, coupon: ' save10 ' });
  assert.equal(figures.discount, 60);
  assert.deepEqual(figures.rows.map((row) => row.lineTax), [18, 32.4]);
  assert.equal(figures.total, 590.4);
});

test('mixed-slab checkout bills and prints ₹603 and reconciles with the ledger', async function (t) {
  const db = {
    nextOrderId: 1001,
    orders: [],
    customers: [{ id: 1, name: 'Test customer', creditLimit: 1000 }],
    products: [
      { id: 1, sku: 'RICE', name: 'Rice', hsn: '1006', price: 100, stock: 10 },
      { id: 2, sku: 'GHEE', name: 'Ghee', hsn: '0405', price: 200, stock: 10 },
      { id: 3, sku: 'TEA', name: 'Tea', hsn: '0902', price: 200, stock: 10 }
    ]
  };
  t.mock.method(store, 'read', function () { return db; });
  const write = t.mock.method(store, 'write', function (savedDb) {
    assert.strictEqual(savedDb, db);
  });

  const server = app.listen(0, '127.0.0.1');
  t.after(function () { return new Promise((resolve) => server.close(resolve)); });
  await once(server, 'listening');
  const baseUrl = 'http://127.0.0.1:' + server.address().port;
  const checkout = {
    items: [{ id: 1, qty: 2 }, { id: 2, qty: 1 }, { id: 3, qty: 1 }],
    coupon: ' save10 ',
    paymentMode: 'khata',
    customerId: 1
  };
  const post = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(checkout)
  };

  const previewResponse = await fetch(baseUrl + '/api/pricing/preview', post);
  assert.equal(previewResponse.status, 200);
  const { totals, couponStatus } = await previewResponse.json();
  assert.equal(couponStatus.code, 'SAVE10');
  const { lines, ...previewTotals } = totals;
  assert.deepEqual(previewTotals, {
    subtotal: 600, discount: 60, taxable: 540, tax: 63, cgst: 31.5, sgst: 31.5, total: 603
  });
  assert.deepEqual(lines.map(({ gstPercent, discount, taxable, tax }) => ({
    gstPercent, discount, taxable, tax
  })), [
    { gstPercent: 5, discount: 20, taxable: 180, tax: 9 },
    { gstPercent: 12, discount: 20, taxable: 180, tax: 21.6 },
    { gstPercent: 18, discount: 20, taxable: 180, tax: 32.4 }
  ]);

  const orderResponse = await fetch(baseUrl + '/api/orders', post);
  assert.equal(orderResponse.status, 201);
  const order = await orderResponse.json();
  const { subtotal, discount, tax, total } = order;
  assert.deepEqual({ subtotal, discount, tax, total }, { subtotal: 600, discount: 60, tax: 63, total: 603 });
  assert.deepEqual(db.orders, [order]);
  assert.equal(write.mock.callCount(), 1);
  assert.equal(db.customers[0].totalBilled, 603);

  const { rows, ...invoiceTotals } = invoice.computeInvoiceFigures(order);
  assert.deepEqual(invoiceTotals, {
    subtotal: 600, discount: 60, tax: 63, cgst: 31.5, sgst: 31.5, total: 603
  });
  assert.deepEqual(rows.map(({ gstPercent, lineTax }) => ({ gstPercent, lineTax })), [
    { gstPercent: 5, lineTax: 9 }, { gstPercent: 12, lineTax: 21.6 }, { gstPercent: 18, lineTax: 32.4 }
  ]);

  const invoiceResponse = await fetch(baseUrl + '/orders/' + order.id + '/invoice');
  assert.equal(invoiceResponse.status, 200);
  const html = await invoiceResponse.text();
  assert.match(html, /CGST \+ SGST \(Total GST\)<\/td><td class="r">₹63\.00/);
  assert.match(html, /Invoice Total<\/td><td class="r">₹603\.00/);
  assert.doesNotMatch(html, /Accountant Reconciliation Notice/);

  const reportResponse = await fetch(baseUrl + '/api/reports/gst-reconciliation');
  assert.equal(reportResponse.status, 200);
  assert.deepEqual(await reportResponse.json(), {
    totalChecked: 1,
    mismatchCount: 0,
    totalDelta: 0,
    rows: [{
      orderId: 1001, date: order.date, customer: 'Test customer', coupon: 'SAVE10',
      ledgerSubtotal: 600, ledgerDiscount: 60, ledgerTax: 63, ledgerTotal: 603,
      invoiceDiscount: 60, invoiceTax: 63, invoiceTotal: 603, delta: 0, matched: true
    }]
  });
});

test('the invoice honors coupon caps, minimums and expiry', function () {
  const items = [{ name: 'Tea', hsn: '0902', price: 2000, qty: 1 }];
  const billed = pricing.computeTotals(items, 'SAVE10');
  const capped = invoice.computeInvoiceFigures({ items, coupon: 'SAVE10', ...billed });
  assert.equal(billed.discount, 150);
  assert.equal(billed.total, 2183);
  assert.equal(capped.discount, 150);
  assert.equal(capped.total, 2183);

  const smallOrder = { items: [{ name: 'Tea', hsn: '0902', price: 100, qty: 1 }] };
  assert.equal(invoice.computeInvoiceFigures({ ...smallOrder, coupon: 'FLAT50' }).discount, 0);
  assert.equal(invoice.computeInvoiceFigures({ items, coupon: 'DIWALI20' }).discount, 0);
});

test('legacy decimal, zero and whole-percent GST rates match pricing', function () {
  const items = [
    { name: 'Decimal rate', price: 100, qty: 1, gstRate: 0.05 },
    { name: 'Zero rate', price: 100, qty: 1, gstRate: 0 },
    { name: 'Whole percent rate', price: 100, qty: 1, gstRate: 12 }
  ];
  assert.deepEqual(pricing.computeTotals(items).lines.map((line) => line.tax), [5, 0, 12]);
  const figures = invoice.computeInvoiceFigures({ items });
  assert.deepEqual(figures.rows.map((row) => row.gstPercent), [5, 0, 12]);
  assert.deepEqual(figures.rows.map((row) => row.lineTax), [5, 0, 12]);
  assert.equal(figures.tax, 17);
});

test('invoice GST sums its rounded line tax', function () {
  const items = [
    { name: 'Tea sample', price: 0.03, qty: 1, hsn: '0902' },
    { name: 'Coffee sample', price: 0.03, qty: 1, hsn: '0901' }
  ];
  const billed = pricing.computeTotals(items);
  assert.equal(billed.tax, 0.02);
  assert.equal(billed.total, 0.08);

  const figures = invoice.computeInvoiceFigures({ items });
  assert.deepEqual(figures.rows.map((row) => row.lineTax), [0.01, 0.01]);
  assert.equal(figures.tax, 0.02);
  assert.equal(figures.cgst, 0.01);
  assert.equal(figures.sgst, 0.01);
  assert.equal(figures.total, 0.08);
});

test('reconciliation and the invoice both flag a GST-only mismatch', function () {
  const order = {
    id: 1, subtotal: 100, discount: 0, tax: 18, total: 105,
    items: [{ name: 'Rice', price: 100, qty: 1, hsn: '1006' }]
  };
  const html = invoice.render(order);
  assert.match(html, /Accountant Reconciliation Notice/);
  assert.match(html, /Invoice GST \(₹5\.00\) differs from Order Ledger recorded GST \(₹18\.00\)/);
  const report = reports.getGstReconciliation({ orders: [order] });
  assert.equal(report.totalChecked, 1);
  assert.equal(report.mismatchCount, 1);
  assert.equal(report.totalDelta, 0);
  assert.equal(report.rows[0].delta, 0);
  assert.equal(report.rows[0].ledgerTax, 18);
  assert.equal(report.rows[0].invoiceTax, 5);
  assert.equal(report.rows[0].matched, false);
});
