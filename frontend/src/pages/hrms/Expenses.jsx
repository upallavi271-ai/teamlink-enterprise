import SimpleRecordPage from '../../components/SimpleRecordPage.jsx';

export default function Expenses() {
  return (
    <SimpleRecordPage
      title="Expense & Travel Claims"
      apiPath="/expenses"
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
  );
}
