import VendorAssets from './VendorAssets.jsx';
import VendorInvoices from './VendorInvoices.jsx';
import VendorIdCards from './VendorIdCards.jsx';
import VendorSim from './VendorSim.jsx';
import { MonthlyBillsPage, PaymentsPage, OfficePage, ExpensesPage } from './VendorMoney.jsx';
import VendorDocuments from './VendorDocuments.jsx';
import VendorProfile from './VendorProfile.jsx';

// THE ONLY FRONTEND MAP of the vendor portal (2026-10-14): registry `screen` name -> the one React screen built for it.
// The list of modules, their labels, icons, routes and permissions come from the server (config/vendorModules.js, served
// by /api/vendor-portal/me). A new module = one registry entry on the server + one screen + one line here. Never a page
// or a route per vendor.
export const SCREENS = {
  assets: VendorAssets,
  invoices: VendorInvoices,
  office: OfficePage,
  expenses: ExpensesPage,
  id_card_orders: VendorIdCards,
  sim_connections: VendorSim,
  monthly_bills: MonthlyBillsPage,
  payments: PaymentsPage,
  documents: VendorDocuments,
  profile: VendorProfile,
};
export default SCREENS;
