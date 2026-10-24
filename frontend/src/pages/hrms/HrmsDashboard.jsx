import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api';
import { useAuth } from '../../context/AuthContext.jsx';
import DashboardExport from '../../components/dashboard/DashboardExport.jsx';
import NewItems from '../../components/dashboard/NewItems.jsx'; // the New button (2026-10-13)
import { Panel, PanelPad, PanelHead, StatRow, AssignRow, EmptyMini, SectionLabel, ScopeNote, TwoCol, QaRow } from '../../components/proto.jsx';
import { isHR as hasHrmsAdmin, can } from '../../permissions';
import ProfileStatusBanner from '../../components/ProfileStatusBanner.jsx';
import Combo from '../../components/Combo.jsx';
import FilterChips from '../../components/FilterChips.jsx';
import DateRangePicker, { useDateRange, rangeParams } from '../../components/DateRangePicker.jsx';
import ChartFromSpec from '../../components/charts/ChartFromSpec.jsx';
import { Tiles, DrillPanel } from './DashboardDrill.jsx';
// Recruiter joinings (2026-10-05): Super Admin's month-end popup + a recruiter's own figure.
import RecruiterJoiningsPopup from '../../components/recruiterJoinings/RecruiterJoiningsPopup.jsx';
import MyJoiningsCard from '../../components/recruiterJoinings/MyJoiningsCard.jsx';
import { isSuperAdmin } from '../../permissions';

const NO_FILTERS = { department: '', location: '', status: '', designation: '', manager: '', q: '' };
// "Medical (16)" — the filter rule: every option says how many people it holds.
const withCount = (label, n) => (n == null ? label : `${label} (${n})`);

// The HR/manager view: every tile, panel and the Export file (GET
// /api/hrms/dashboard/export) are computed against the same filtered employee set.
//
// The date range (it replaces a "Date Range" select that was never sent to
// the server) moves the dated tiles — attendance, on leave, new joiners and
// the leave overview — and their labels say so. Tiles marked "(now)" are the
// state of things today whatever range is picked.
function HrDashboard() {
  const [filters, setFilters] = useState(NO_FILTERS);
  const [range, setRange] = useDateRange('tl_dash_range_hrms');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  // The tile whose list is open under its row: { section, tile, part, scope, expected }.
  const [drill, setDrill] = useState(null);
  // The employee search box: typed here, sent to the server a moment after typing stops.
  const [qText, setQText] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setFilters((f) => (f.q === qText.trim() ? f : { ...f, q: qText.trim() })), 350);
    return () => clearTimeout(t);
  }, [qText]);

  useEffect(() => {
    const params = new URLSearchParams(rangeParams(range));
    Object.keys(filters).forEach((k) => { if (filters[k]) params.set(k, filters[k]); });
    api.get(`/hrms/dashboard?${params.toString()}`)
      .then((res) => { setData(res.data); setError(''); })
      .catch((err) => setError(err.response?.data?.error || 'Could not load the dashboard'));
  }, [filters, range]);

  if (!data) return error ? <div className="notice red">{error}</div> : <div className="small-muted">Loading…</div>;
  const set = (k, v) => setFilters((f) => ({ ...f, [k]: v }));
  const anyFilter = Object.values(filters).some(Boolean) || range.range !== 'today';
  const o = data.filterOptions;
  // "New Joiners — This Month" moved with the range; "Active (now)" did not.
  const p = data.period;
  const inP = (label) => `${label} — ${p.name}`;
  const now = (label) => `${label} (now)`;
  const eo = data.employeeOverview;
  const ao = data.attendanceOverview;
  const lo = data.leaveOverview;
  const pt = data.pendingTasks;
  // The dashboard's filters + date range, sent with every list so a list is counted exactly like its tile.
  const params = { ...rangeParams(range), ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v)) };
  const pick = (section, c, expected) => setDrill((cur) => (cur && cur.section === section && cur.tile === c.tile && (cur.part || '') === (c.part || '') && (cur.scope || '') === (c.scope || '')
    ? null
    : { section, tile: c.tile, part: c.part || '', scope: c.scope || '', expected }));
  const isDrill = (tile, part, scope) => !!drill && drill.tile === tile && (drill.part || '') === part && (drill.scope || '') === scope;
  const deptWorking = data.headcountByDepartment.reduce((n, d) => n + d.working, 0);
  const deptLeft = data.headcountByDepartment.reduce((n, d) => n + d.left, 0);
  const birthdays = data.celebrations.filter((c) => c.kind === 'Birthday').length;
  // On Leave in the attendance row vs "Leave approved for this date" above it: say why they can differ.
  const kinds = ao.onLeaveKinds || {};
  const notes = ao.notes || {};
  const hl = ao.halfDayLeave || null; // the Half day tile: 1st / 2nd half and Approved / Pending / Rejected / No leave
  // Total Employees counts every employee record (also people who left); the Headcount is
  // only the people on the rolls on the date. Said once, with the numbers.
  const off = ao.offTheRolls || { total: 0 };
  const headcountNote = off.total > 0
    ? `${eo.total} employees in total - ${off.total} not on the rolls on this date (${[off.left ? `${off.left} had left` : '', off.notJoinedYet ? `${off.notJoinedYet} not joined yet` : ''].filter(Boolean).join(', ')})`
    : 'Same as Total Employees';
  // LEAVE vs ATTENDANCE, reconciled: every approved request that overlaps the date lands in ONE tile.
  const lr = ao.leaveReconcile || { requests: 0, landed: {} };
  const ld = lr.landed || {};
  const L = (k) => (ld[k] ? ld[k].requests : 0);
  const P = (k) => (ld[k] ? ld[k].people : 0); // the same leaves as PEOPLE (what the lists show)
  const tn = ao.tileNotes || {};
  const NOTE_TXT = { late: 'Late', earlyLogout: 'Early logout', missingCheckIn: 'Missing check-in', missingCheckOut: 'Missing check-out', noPunches: 'No punches', punchOnLeave: 'Punch on a leave day', leaveRejected: 'Half-day leave rejected' };
  // Small clickable notes for a tile (Half day / On leave): only the ones somebody has.
  const noteChips = (tileKey) => Object.keys(NOTE_TXT).filter((k) => (tn[tileKey] || {})[k] > 0).map((k) => ({ label: NOTE_TXT[k], n: tn[tileKey][k], part: k, tone: 'orange' }));
  const onLeaveNote = (kinds.pending || kinds.informed)
    ? `Full-day leave ${kinds.approved || 0} · waiting for approval ${kinds.pending || 0} · informed ${kinds.informed || 0}`
    : 'full-day leave';
  // "Leave requests 2 = Approved 2 -> 1 on leave + 1 half day" in plain words.
  const landWords = [
    L('onLeave') ? `${L('onLeave')} on leave (full day)` : '', L('halfDay') ? `${L('halfDay')} half day` : '',
    L('offDay') ? `${L('offDay')} on a week off / holiday` : '', L('present') ? `${L('present')} came to work (Present)` : '',
    L('notOnRolls') ? `${L('notOnRolls')} from people no longer on the rolls that day` : '', L('other') ? `${L('other')} in other tiles` : '',
  ].filter(Boolean);
  const lvChips = [
    L('onLeave') ? { label: `Full day ${L('onLeave')}${P('onLeave') !== L('onLeave') ? ` (${P('onLeave')} people)` : ''} → On leave tile`, n: P('onLeave'), tile: 'attOnLeave', part: 'approved', tone: 'green' } : null,
    L('halfDay') ? { label: `Half day ${L('halfDay')}${P('halfDay') !== L('halfDay') ? ` (${P('halfDay')} people)` : ''} → Half day tile`, n: P('halfDay'), tile: 'halfDay', part: 'Approved', tone: 'green' } : null,
    L('offDay') ? { label: `${L('offDay')} → Week off / Holiday (not a working day)`, n: L('offDay') } : null,
    L('present') ? { label: `${L('present')} came to work → Present`, n: L('present') } : null,
    L('notOnRolls') ? { label: `${L('notOnRolls')} → no longer on the rolls`, n: L('notOnRolls') } : null,
    L('other') ? { label: `${L('other')} → other tiles`, n: L('other') } : null,
  ].filter(Boolean);

  return (
    <div>
      <div className="filter-row" style={{ marginBottom: 16 }}>
        <DateRangePicker value={range} onChange={setRange} period={data.period} />
        <Combo value={filters.department} title="Department" onChange={(e) => set('department', e.target.value)}>
          <option value="">All departments</option>
          {o.departments.map((d) => <option key={d} value={d}>{withCount(d, o.counts?.department?.[d])}</option>)}
        </Combo>
        <Combo value={filters.location} title="Location" onChange={(e) => set('location', e.target.value)}>
          <option value="">All locations</option>
          {o.locations.map((l) => <option key={l} value={l}>{withCount(l, o.counts?.location?.[l])}</option>)}
        </Combo>
        <Combo value={filters.status} title="Employee status" onChange={(e) => set('status', e.target.value)}>
          <option value="">All employee statuses</option>
          {o.statuses.map((s) => <option key={s} value={s}>{withCount(s, o.counts?.status?.[s])}</option>)}
        </Combo>
        <Combo value={filters.designation} title="Designation" onChange={(e) => set('designation', e.target.value)}>
          <option value="">All designations</option>
          {(o.designations || []).map((d) => <option key={d} value={d}>{withCount(d, o.counts?.designation?.[d])}</option>)}
        </Combo>
        <Combo value={filters.manager} title="Reporting manager" onChange={(e) => set('manager', e.target.value)}>
          <option value="">{o.managers.length ? 'All reporting managers' : 'No reporting managers set'}</option>
          {o.managers.map((m) => <option key={m.id} value={m.id}>{withCount(m.name, m.count)}</option>)}
        </Combo>
        <input type="search" className="hd-find" value={qText} onChange={(e) => setQText(e.target.value)} placeholder="Find an employee (name or ID)" aria-label="Find an employee by name or ID" />
        {anyFilter && <button className="btn btn-sm" onClick={() => { setQText(''); setFilters(NO_FILTERS); setRange({ range: 'today', from: '', to: '' }); }}>Clear filters</button>}
        {data.mayExport && <span style={{ marginLeft: 'auto' }}><DashboardExport url="/hrms/dashboard/export" params={params} className="btn btn-sm btn-primary" /></span>}
      </div>
      {/* Every active filter as a removable chip, so nothing narrows the
          tiles silently (the date range shows on its own picker). */}
      <FilterChips
        filters={[
          { key: 'department', label: 'Department', value: filters.department, onRemove: () => set('department', '') },
          { key: 'location', label: 'Location', value: filters.location, onRemove: () => set('location', '') },
          { key: 'status', label: 'Employee status', value: filters.status, onRemove: () => set('status', '') },
          { key: 'designation', label: 'Designation', value: filters.designation, onRemove: () => set('designation', '') },
          { key: 'q', label: 'Employee', value: filters.q, onRemove: () => { setQText(''); set('q', ''); } },
          { key: 'manager', label: 'Reporting manager', value: filters.manager ? ((o.managers.find((m) => String(m.id) === String(filters.manager)) || {}).name || filters.manager) : '', onRemove: () => set('manager', '') },
        ]}
      />

      {error && <div className="notice red">{error}</div>}

      {data.employeeOverview.total === 0 && (
        <ScopeNote>No employee records match these filters — the counts below are genuinely zero, not placeholders.</ScopeNote>
      )}

      <SectionLabel>Employee Overview</SectionLabel>
      <Tiles section="emp" drill={drill} onPick={pick} cells={[
        { id: 'total', tile: 'total', value: eo.total, label: now('Total Employees') },
        { id: 'active', tile: 'active', value: eo.active, label: now('Active') },
        { id: 'notice', tile: 'notice', value: eo.servingNotice, label: now('Serving Notice') },
        { id: 'exit', tile: 'exitProcess', value: eo.exitProcess, label: now('Exit Process') },
        { id: 'left', tile: 'left', value: eo.left, label: now('Left'), parts: [{ label: 'Relieved', n: eo.relieved, part: 'relieved' }, { label: 'Exited', n: eo.exited, part: 'exited' }] },
        ...(eo.other ? [{ id: 'other', tile: 'other', value: eo.other, label: now('Other Status'), sub: (eo.otherStatuses || []).join(', ') }] : []),
      ]} />
      {/* THE FIRST ROW ADDS UP — said out loud, like the attendance row does. */}
      <div className="hd-eq">
        Active <b>{eo.active}</b> + Notice period <b>{eo.servingNotice}</b> + Exit process <b>{eo.exitProcess}</b> + Left <b>{eo.left}</b> (Relieved {eo.relieved} · Exited {eo.exited}){eo.other ? <> + Other <b>{eo.other}</b></> : null} = Total employees <b>{eo.total}</b>.
        {' '}The system Super Admin account is not counted as an employee.
      </div>
      {/* EXIT APPROVALS (HRMS spec item 6): for the Super Admin and HR desk only (the server sends it only to them). */}
      {data.exitApprovals && (
        <div className="hd-eq">
          {data.exitApprovals.waiting > 0 ? <>Exit approvals waiting: <b>{data.exitApprovals.waiting}</b></> : <>No exit is waiting for approval</>}
          {' · '}{data.exitApprovals.exitsThisMonth > 0 ? <>Left in {data.exitApprovals.monthLabel}: <b>{data.exitApprovals.exitsThisMonth}</b></> : <>Nobody has left in {data.exitApprovals.monthLabel} so far</>}.
          {' '}<Link to="/employee-services?tab=resignation&view=exits">Open Exit approvals</Link>
        </div>
      )}
      <div className="hd-subhead">{`For ${p.name}`}</div>
      <Tiles section="emp" drill={drill} onPick={pick} cells={[
        { id: 'new', tile: 'newJoiners', value: eo.newJoiners, label: inP('New Joiners') },
        {
          id: 'leave', tile: 'onLeave', value: eo.onLeave, label: 'Leave approved for this date',
          sub: p.days > 1 ? `any day in ${p.name}` : p.label,
          help: 'People with an APPROVED leave request that covers the date (or any day of the range) picked above. This is not the same as On Leave in the attendance row below: someone on approved leave on a week-off or holiday is counted here but shown under Week-off / Holiday there, and someone on half-day leave who worked the other half is shown under Half Day.',
        },
      ]} />
      {drill && drill.section === 'emp' && (
        <DrillPanel drill={drill} expected={drill.expected} params={params} onClose={() => setDrill(null)} moreTo="/employees" moreLabel="Open Employee Management"
          switches={drill.tile === 'left' ? [{ label: 'All who left', part: '', n: eo.left }, { label: 'Relieved', part: 'relieved', n: eo.relieved }, { label: 'Exited', part: 'exited', n: eo.exited }] : null}
          onSwitch={(x) => setDrill((d) => ({ ...d, part: x.part, expected: x.n }))} />
      )}

      {/* PEOPLE ON ONE DAY, not person-days: the range's last day (today when
          the range runs on past it), out of the people on the rolls that day.
          The buckets add up to the headcount, and match the Attendance
          page's Dashboard for the same date. */}
      <SectionLabel>{`Attendance on ${ao.asOf} — people on the rolls that day${p.days > 1 ? ` (last day of ${p.name}; the charts below cover the whole range)` : ''}`}</SectionLabel>
      {/* THE TILE SET (user, 2026-10-09): Present / Absent / Half day / On leave / Week off-Holiday
          always add up to the Headcount. Present = everyone who came to work, so Late, Early
          logout, Missing check-in and Missing check-out are only small notes INSIDE it. */}
      <Tiles section="att" drill={drill} onPick={pick} cells={[
        { id: 'headcount', tile: 'headcount', value: ao.headcount, label: 'Headcount on the rolls', sub: headcountNote,
          help: 'Everyone on the company rolls on this date: joined on or before it and not yet left. The five tiles beside it add up to this number.' },
        {
          id: 'present', tile: 'present', value: ao.present, label: 'Present', sub: 'Came to work',
          help: 'Everyone who came to work. This includes people who were late, left early, or have a check-in or check-out missing - they are counted once, here. The small notes below only tell you how many of them.',
          parts: [
            { label: `Late (after ${ao.lateAfter || '9:15 AM'})`, n: notes.late || 0, part: 'late' },
            // LATE COMING: did they tell why, and was it approved? (an approved one is not a payroll late)
            ...(ao.lateStates && ao.lateStates.late ? [
              { label: 'Late: Approved', n: ao.lateStates.approved, tile: 'late', part: 'approved', tone: 'green', title: 'Came late, told why, and a manager approved. Stays Present and is not counted as a late arrival in payroll.' },
              { label: 'Waiting for approval', n: ao.lateStates.pending, tile: 'late', part: 'pending', tone: 'orange' },
              ...(ao.lateStates.rejected ? [{ label: 'Rejected', n: ao.lateStates.rejected, tile: 'late', part: 'rejected', tone: 'red' }] : []),
              { label: 'Not explained', n: ao.lateStates.none, tile: 'late', part: 'none', tone: 'red', title: 'Came late and nobody was told why. Counts as a late arrival.' },
            ] : []),
            { label: 'Early logout', n: notes.earlyLogout || 0, part: 'earlyLogout' },
            { label: 'Missing check-in', n: notes.missingCheckIn || 0, part: 'missingCheckIn' },
            { label: 'Missing check-out', n: notes.missingCheckOut || 0, part: 'missingCheckOut' },
          ],
        },
        { id: 'absent', tile: 'absent', value: ao.absent, label: 'Absent', parts: noteChips('absent') },
        {
          id: 'half', tile: 'halfDay', value: ao.halfDay, label: 'Half day',
          sub: hl ? `Leave for 1st half ${hl.firstHalf} · 2nd half ${hl.secondHalf}` : undefined,
          help: 'Worked one half. The leave for the other half is Approved, Pending approval (unpaid until approved), Rejected, or never applied (No leave).',
          parts: [
            ...(hl ? [
              { label: 'Leave: Approved', n: hl.approved, part: 'Approved', tone: 'green' },
              { label: 'Pending', n: hl.pending, part: 'Pending', tone: 'orange' },
              ...(hl.rejected ? [{ label: 'Rejected', n: hl.rejected, part: 'Rejected', tone: 'red' }] : []),
              { label: 'No leave', n: hl.none, part: 'None', tone: 'red' },
            ] : []),
            ...noteChips('halfDay'),
          ],
        },
        {
          id: 'leave', tile: 'attOnLeave', value: ao.onLeave, label: 'On leave', sub: onLeaveNote,
          help: 'People on a FULL-day leave (approved, waiting for approval, or told the manager). A half-day leave is counted in Half day, not here, so Present + Absent + Half day + On leave + Week off / Holiday = Headcount.',
          parts: [
            ...(L('halfDay') ? [{ label: `+ ${L('halfDay')} on half-day leave (counted in Half day)`, n: L('halfDay'), tile: 'halfDay', part: 'Approved', tone: 'green', title: 'Half-day leave is counted in the Half day tile. Click to see them.' }] : []),
            ...noteChips('onLeave'),
          ],
        },
        { id: 'off', tile: 'offDay', value: ao.offDay, label: 'Week off / Holiday', sub: 'Sunday and company holidays' },
        ...(ao.noRecord ? [{ id: 'norec', tile: 'noRecord', value: ao.noRecord, label: 'No device data' }] : []),
        ...(ao.notYet ? [{ id: 'notyet', tile: 'notYet', value: ao.notYet, label: 'Not checked in yet' }] : []),
        ...(ao.upcoming ? [{ id: 'upc', tile: 'upcoming', value: ao.upcoming, label: 'Upcoming day' }] : []),
        // Regularization Pending (now) was the same figure as "Attendance
        // Regularization" under Pending Tasks & Approvals — shown there once.
      ]} />
      <div className="hd-eq" data-testid="att-equation">
        Present <b>{ao.present}</b> + Absent <b>{ao.absent}</b> + Half day <b>{ao.halfDay}</b> + On leave <b>{ao.onLeave}</b> + Week off / Holiday <b>{ao.offDay}</b>
        {ao.noRecord ? <> + No device data <b>{ao.noRecord}</b></> : ''}{ao.notYet ? <> + Not checked in yet <b>{ao.notYet}</b></> : ''}{ao.upcoming ? <> + Upcoming <b>{ao.upcoming}</b></> : ''} = Headcount <b>{ao.headcount}</b>
        {'. '}Late, Early logout, Missing check-in and Missing check-out are not extra tiles - those people are already counted in Present.
      </div>
      {ao.lateChips ? <div className="hd-eq" data-testid="late-chips">{ao.lateChips}. An approved late coming stays Present and is not counted as a late arrival.</div> : null}
      {drill && drill.section === 'att' && (
        <DrillPanel drill={drill} expected={drill.expected} params={params} onClose={() => setDrill(null)} moreTo="/attendance" moreLabel="Open the full Attendance page" />
      )}

      <SectionLabel>{`Leave Overview — requests overlapping ${p.name}`}</SectionLabel>
      {/* THE LEAVE NUMBERS EXPLAIN THEMSELVES: requests -> where each lands in the attendance tiles. */}
      <div className="hd-eq hd-lv-sentence" data-testid="leave-sentence">
        <b>Leave requests {lo.total}</b> = Approved <b>{lo.approved}</b>
        {lr.requests > 0 && landWords.length > 0 ? <> → {landWords.join(' + ')}</> : null}
        {lo.pending || lo.rejected || lo.cancelled || lo.cancellationRequests ? <> + Pending <b>{lo.pending}</b>{lo.pendingOther ? <> + Old or left pending <b>{lo.pendingOther}</b></> : null} + Rejected <b>{lo.rejected}</b> + Cancelled <b>{lo.cancelled}</b>{lo.cancellationRequests ? <> + Cancellation asked <b>{lo.cancellationRequests}</b></> : null}</> : null}.
        {' '}This overview counts <b>requests</b>; the attendance tiles count <b>people</b> on {ao.asOf}.
        {lo.approvedPeople != null && lo.approvedPeople !== lo.approved ? <> The {lo.approved} approved requests are from <b>{lo.approvedPeople}</b> {lo.approvedPeople === 1 ? 'person' : 'people'} (a person with two requests counts twice here).</> : null}
        {lr.peopleWithMore ? <> {lr.peopleWithMore} {lr.peopleWithMore === 1 ? 'person has' : 'people have'} two approved requests on {ao.asOf}.</> : null}
        {p.days > 1 ? <> Rule for a range: the requests are all those that overlap {p.name}; the attendance tiles show the last day ({ao.asOf}), and the arrows below are for that day.</> : null}
      </div>
      <Tiles section="leave" drill={drill} onPick={pick} cells={[
        { id: 'total', tile: 'leaveTotal', value: lo.total, label: 'Leave Requests' },
        { id: 'pending', tile: 'leavePending', value: lo.pending, label: 'Pending Approvals', sub: 'Only leave dated in this range' },
        {
          id: 'approved', tile: 'leaveApproved', value: lo.approved, label: 'Approved', sub: `${lo.approvedFullDay || 0} full day · ${lo.approvedHalfDay || 0} half day · ${lo.approvedPeople || 0} ${lo.approvedPeople === 1 ? 'person' : 'people'}`,
          parts: lvChips,
        },
        { id: 'rejected', tile: 'leaveRejected', value: lo.rejected, label: 'Rejected' },
        { id: 'cancelled', tile: 'leaveCancelled', value: lo.cancelled, label: 'Cancelled' },
        ...(lo.cancellationRequests ? [{ id: 'asked', tile: 'leaveCancelAsked', value: lo.cancellationRequests, label: 'Cancellation Asked' }] : []),
        { id: 'upcoming', tile: 'leaveUpcoming', value: lo.upcoming, label: 'Upcoming Leaves (from today)', sub: 'Approved, starting after today. Not part of the total.' },
      ]} />
      <div className="hd-eq">
        Pending <b>{lo.pending}</b>{lo.pendingOther ? <> + Old or left pending <b>{lo.pendingOther}</b></> : null} + Approved <b>{lo.approved}</b> + Rejected <b>{lo.rejected}</b> + Cancelled <b>{lo.cancelled}</b>{lo.cancellationRequests ? <> + Cancellation asked <b>{lo.cancellationRequests}</b></> : null} = Leave Requests <b>{lo.total}</b>.
        {/* The split of the approved requests is the sentence above the tiles and the chips under Approved. */}
      </div>
      {drill && drill.section === 'leave' && (
        <DrillPanel drill={drill} expected={drill.expected} params={params} onClose={() => setDrill(null)} moreTo="/leave" moreLabel="Open Leave Requests" />
      )}

      {/* hrms-24 §9 — built by the server from exactly the figures in the
          tiles above: same range, same filters, same scope. */}
      {(data.charts || []).length > 0 && (
        <>
          <SectionLabel>{`Charts — ${p.name} (attendance charts are person-days: every day of the range added up)`}</SectionLabel>
          <div className="tlc-grid2">
            {data.charts.map((c) => <ChartFromSpec key={c.id} spec={c} />)}
          </div>
        </>
      )}

      <div style={{ marginTop: 16 }}>
        <PanelPad>
          <h3 style={{ marginBottom: 12, fontSize: 14 }}>Pending Tasks &amp; Approvals (now)</h3>
          <Tiles section="tasks" drill={drill} onPick={pick} cells={[
            { id: 'leave', tile: 'taskLeave', value: pt.leaveApprovals, label: 'Leave Approvals', sub: `Really waiting, any dates${(pt.leaveApprovalsFromLeft || pt.leaveOldPending || pt.leaveDuplicatePending) ? `. Not counted: ${pt.leaveApprovalsFromLeft || 0} from people who left, ${pt.leaveOldPending || 0} old, ${pt.leaveDuplicatePending || 0} repeated (Leave > Sync with Pulse)` : ''}` },
            { id: 'reg', tile: 'taskRegularization', value: pt.attendanceRegularization, label: 'Attendance Regularization' },
            ...(pt.lateComing != null ? [{ id: 'latec', tile: 'taskLateComing', value: pt.lateComing, label: 'Late coming', sub: 'Waiting for approval' }] : []),
            { id: 'assets', tile: 'taskAssets', value: pt.assetsAssigned, label: 'Assets Assigned' },
            { id: 'training', tile: 'taskTraining', value: pt.trainingPending, label: 'Training Pending' },
            { id: 'targets', tile: 'taskTargets', value: pt.openTargets, label: 'Open Targets' },
            { id: 'tickets', tile: 'taskTickets', value: pt.openTickets, label: 'Open Tickets' },
          ]} />
          {drill && drill.section === 'tasks' && (
            <DrillPanel drill={drill} expected={drill.expected} params={params} onClose={() => setDrill(null)}
              moreTo={{ taskLeave: '/leave', taskRegularization: '/attendance', taskLateComing: '/attendance?tab=late', taskTraining: '/performance', taskTargets: '/performance' }[drill.tile] || '/employee-services'} moreLabel="Open the full page" />
          )}
        </PanelPad>
      </div>

      <TwoCol>
        <Panel>
          <PanelHead title={`Headcount by Department (now) — ${deptWorking} working, ${deptLeft} left`} />
          {data.headcountByDepartment.length === 0
            ? <EmptyMini>No employees in scope.</EmptyMini>
            : (
              <div className="hd-scroll">
                {data.headcountByDepartment.map((d) => (
                  <AssignRow key={d.department}>
                    <span>{d.department}</span>
                    <span className="cell-muted" style={{ fontSize: 11.5 }}>
                      <button type="button" className={`hd-link${isDrill('dept', d.department, 'working') ? ' on' : ''}`} onClick={() => pick('dept', { tile: 'dept', part: d.department, scope: 'working' }, d.working)}>{d.working} working</button>
                      <button type="button" className={`hd-link${isDrill('dept', d.department, 'left') ? ' on' : ''}`} onClick={() => pick('dept', { tile: 'dept', part: d.department, scope: 'left' }, d.left)}>{d.left} left</button>
                    </span>
                  </AssignRow>
                ))}
              </div>
            )}
          <div className="small-muted" style={{ fontSize: 11.5, padding: '8px 14px' }}>
            Working <b>{deptWorking}</b> + Left <b>{deptLeft}</b> = Total employees <b>{eo.total}</b>. Working = everyone except Relieved / Exited.
          </div>
        </Panel>
        <Panel>
          <PanelHead title={`Birthdays & Anniversaries (next 30 days) — ${data.celebrations.length}`} />
          {data.celebrations.length === 0
            ? <EmptyMini>None in the next 30 days.</EmptyMini>
            : (
              <>
                <div className="hd-celeb-head">
                  <button type="button" className={`hd-link${isDrill('celebrations', '', '') ? ' on' : ''}`} style={{ marginLeft: 0 }} onClick={() => pick('cel', { tile: 'celebrations', part: '' }, data.celebrations.length)}>All {data.celebrations.length}</button>
                  <button type="button" className={`hd-link${isDrill('celebrations', 'Birthday', '') ? ' on' : ''}`} onClick={() => pick('cel', { tile: 'celebrations', part: 'Birthday' }, birthdays)}>Birthdays {birthdays}</button>
                  <button type="button" className={`hd-link${isDrill('celebrations', 'Work Anniversary', '') ? ' on' : ''}`} onClick={() => pick('cel', { tile: 'celebrations', part: 'Work Anniversary' }, data.celebrations.length - birthdays)}>Anniversaries {data.celebrations.length - birthdays}</button>
                </div>
                <div className="hd-scroll">
                  {data.celebrations.map((c) => (
                    <AssignRow key={`${c.name}-${c.kind}`}>
                      <span>{c.name} <span className="cell-muted" style={{ fontSize: 11.5 }}>— {c.kind}{c.years ? ` (${c.years} yr)` : ''}</span></span>
                      <span className="cell-muted" style={{ fontSize: 11.5 }}>{c.inDays === 0 ? 'Today' : `in ${c.inDays} day${c.inDays === 1 ? '' : 's'}`} · {String(c.on || c.date).slice(0, 10)}</span>
                    </AssignRow>
                  ))}
                </div>
              </>
            )}
        </Panel>
      </TwoCol>
      {drill && (drill.section === 'dept' || drill.section === 'cel') && (
        <DrillPanel drill={drill} expected={drill.expected} params={params} onClose={() => setDrill(null)} />
      )}

      <TwoCol>
        <Panel>
          <PanelHead title="Announcements" />
          {data.announcements.length === 0
            ? <EmptyMini>No announcements posted.</EmptyMini>
            : data.announcements.map((a) => (
              <AssignRow key={a.id}>
                <span>{a.title} <span className="cell-muted" style={{ fontSize: 11.5 }}>— {a.category || 'General'}</span></span>
                <span className="cell-muted" style={{ fontSize: 11.5 }}>{a.date}</span>
              </AssignRow>
            ))}
        </Panel>
        <Panel>
          <PanelHead title="Upcoming Holidays" />
          {data.upcomingHolidays.length === 0
            ? <EmptyMini>No upcoming holidays configured.</EmptyMini>
            : data.upcomingHolidays.map((h) => (
              <AssignRow key={h.id}>
                <span>{h.name}</span>
                <span className="cell-muted" style={{ fontSize: 11.5 }}>{h.date}</span>
              </AssignRow>
            ))}
        </Panel>
      </TwoCol>
    </div>
  );
}

// The self-service view for employees, who can't read company-wide aggregates.
function MyDashboard() {
  const [attendance, setAttendance] = useState([]);
  const [leave, setLeave] = useState([]);
  const [balances, setBalances] = useState(null);
  const [holidays, setHolidays] = useState([]);
  const [announcements, setAnnouncements] = useState([]);

  useEffect(() => {
    api.get('/attendance').then((res) => setAttendance(res.data));
    api.get('/leave').then((res) => setLeave(res.data));
    api.get('/leave/balances').then((res) => setBalances(res.data)).catch(() => setBalances(null));
    api.get('/leave/holidays').then((res) => setHolidays(res.data));
    api.get('/announcements').then((res) => setAnnouncements(res.data));
  }, []);

  const today = new Date().toISOString().slice(0, 10);
  const todayRecord = attendance.find((a) => a.date === today);
  const myBalances = balances?.rows?.[0]?.balances || [];
  const upcoming = holidays.filter((h) => h.date >= today);

  return (
    <div>
      <SectionLabel>My Day</SectionLabel>
      <StatRow columns={3} cells={[
        { value: todayRecord?.status || 'Not marked', label: "Today's Attendance", to: '/attendance' },
        { value: leave.filter((l) => l.status === 'Pending').length, label: 'Leave Pending', to: '/leave' },
        { value: leave.filter((l) => l.status === 'Approved').length, label: 'Leave Approved', to: '/leave' },
      ]} />

      <TwoCol style={{ marginTop: 16 }}>
        <Panel>
          <PanelHead title="My Leave Balances" />
          {myBalances.length === 0
            ? <EmptyMini>No balances configured yet.</EmptyMini>
            : myBalances.map((b) => (
              <AssignRow key={b.code}><span>{b.type}</span><b>{b.total == null ? '—' : `${b.remaining} / ${b.total}`}</b></AssignRow>
            ))}
        </Panel>
        <Panel>
          <PanelHead title="Upcoming Holidays" />
          {upcoming.length === 0
            ? <EmptyMini>None configured.</EmptyMini>
            : upcoming.slice(0, 4).map((h) => (
              <AssignRow key={h.id}><span>{h.name}</span><span className="cell-muted" style={{ fontSize: 11.5 }}>{h.date}</span></AssignRow>
            ))}
        </Panel>
      </TwoCol>

      <Panel style={{ marginTop: 16 }}>
        <PanelHead title="Announcements" />
        {announcements.length === 0
          ? <EmptyMini>No announcements posted.</EmptyMini>
          : announcements.slice(0, 3).map((a) => (
            <AssignRow key={a.id}><span>{a.title}</span><span className="cell-muted" style={{ fontSize: 11.5 }}>{a.date}</span></AssignRow>
          ))}
      </Panel>
    </div>
  );
}

export default function HrmsDashboard() {
  const { user } = useAuth();
  const isHR = hasHrmsAdmin(user);
  // A Quick Action is a shortcut to a screen, so it is offered only where the
  // screen itself is. Payroll is the Accounts desk's (see utils/permissions.js)
  // and is not in the HR desk's nav (§6), so "Process Payroll" must not be the
  // one link that puts it back.
  const canSeePayroll = can(user, 'hrms', 'hrms', 'Payroll & Compensation', 'view');

  return (
    <div>
      <div className="page-head"><div><h1>HRMS Dashboard</h1><div className="page-sub">Employee &amp; Workforce Management</div></div></div>
      <NewItems />

      {/* FIRST LOGIN. A new employee used to land here with nothing telling
          them a profile was waiting to be filled in. The banner says so, and
          routes them to the form; once HR approves it says that instead. */}
      {!isHR && <ProfileStatusBanner variant="landing" />}

      {isSuperAdmin(user) && <RecruiterJoiningsPopup />}
      <MyJoiningsCard />

      {isHR ? <HrDashboard /> : <MyDashboard />}

      <PanelPad>
        <h3 style={{ fontSize: 14, marginBottom: 10 }}>Quick Actions</h3>
        <QaRow>
          <Link className="btn btn-sm" to="/attendance">Attendance</Link>
          <Link className="btn btn-sm" to="/leave">Leave Requests</Link>
          {canSeePayroll && <Link className="btn btn-sm" to="/payroll">Process Payroll</Link>}
          <Link className="btn btn-sm" to="/performance">Performance</Link>
          <Link className="btn btn-sm" to="/employee-services">Employee Services</Link>
          {isHR && <Link className="btn btn-sm" to="/employees">Employee Management</Link>}
          {!isHR && <Link className="btn btn-sm" to="/my-profile">My Profile</Link>}
        </QaRow>
      </PanelPad>
    </div>
  );
}
