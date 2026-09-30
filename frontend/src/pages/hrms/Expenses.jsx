import { useState } from 'react';
import SimpleRecordPage from '../../components/SimpleRecordPage.jsx';
import DataIoBar from '../../components/dataio/DataIoBar.jsx';

export default function Expenses() {
  // Bumped after an import so the list below reloads.
  const [reloadKey, setReloadKey] = useState(0);
  return (
    <div>
      {/* Export all (everyone in scope; own claims without the export right) ·
          Export one employee · Import historical claims with the compulsory
          sample — no bills, no approval steps, no notifications
          (backend src/io/expenses.js). Sits at the right of the page title. */}
      <div style={{ float: 'right', marginLeft: 12, marginTop: 4 }}>
        <DataIoBar ioKey="expenses" onImported={() => setReloadKey((k) => k + 1)} />
      </div>
      <SimpleRecordPage
        key={reloadKey}
        title="Expense & Travel Claims"
        apiPath="/expenses"
        // One person's claim — the claimant's own. No Send-to picker here.
        createLabel="New Expense Claim"
        aiKind="expense"
        titleLabel="Description"
        detailLabel="Notes"
        showCategory
        categoryLabel="Category"
        categoryOptions={['Food', 'Travel', 'Accommodation', 'Other']}
        showLocation
        showDate
        dateLabel="Date"
        showAmount
        amountLabel="Amount (₹)"
        // A claim carries its actual bill: a real upload, stored server-side
        // outside the repository, downloadable only by someone who can already
        // see the claim. See backend/src/utils/attachments.js.
        showAttachment
        attachmentLabel="Bill / Receipt"
        statuses={['Pending', 'Approved', 'Reimbursed', 'Rejected']}
        decisions={['Approved', 'Reimbursed', 'Rejected']}
      />
    </div>
  );
}
