// An internal flag for the vendor EXPORT (utils/vendorExport.js): "give me every row of this list, not one page". It is a Symbol on purpose -
// a query string or a JSON body can only carry text, so a vendor can never switch it on from the outside; only the export code can.
const EXPORT_ALL = Symbol.for('teamlink.vendorExportAll');
// The most rows one export may hold (a larger list is refused with a plain message, never cut off silently).
const MAX_EXPORT_ROWS = 10000;
const wantsAll = (q) => !!(q && q[EXPORT_ALL] === true);
module.exports = { EXPORT_ALL, MAX_EXPORT_ROWS, wantsAll };
