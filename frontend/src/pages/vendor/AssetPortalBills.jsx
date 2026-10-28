// /vendor/asset-portal/bills - MY BILLS (founder 28 Oct 2026: its own menu under Assets, no longer a tab of Invoices & Payments).
// The same list and upload as before (AssetPortalBillUploads.jsx MyBills): every bill photo / PDF this vendor uploaded, where each one
// stands, the items read from it and the asset + who has it. Nothing new is stored here.
import { MyBills } from './AssetPortalBillUploads.jsx';
import VendorShell from './VendorShell.jsx';
import './vendorModules.css';
import './billUploads.css';

export default function AssetPortalBills() {
  return (
    <VendorShell title="My Bills" sub="The repair bills you uploaded as photos or PDFs, where each one is, and the asset on every line.">
      <MyBills />
    </VendorShell>
  );
}
