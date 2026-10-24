// ---------------------------------------------------------------------------
// THE JOINING DAY IN THE CANDIDATE LISTS (user, 2026-10-22: "it says Joined, but on WHICH date?").
//
// The rule is utils/joinDayShared.js (typed joining date, else the joined-at time as an India day, else the day the application
// moved into Joined, else "not recorded"). This file only feeds that one rule from the rows the lists already hold:
//   * movesFor(apps)         the move-into-Joined time of the joined applications that have neither a typed day nor a joined-at
//                            time (one chunked read for all of them - never one query per row);
//   * dayOfApp(app, moves)   the joining day of ONE application (null = not recorded, or not joined);
//   * joinInfoOfPerson(...)  the person-level answer for the People list: the joined application whose date is shown, which may be
//                            another application than the primary (shown) one.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const JD = require('./joinDayShared');

const JOINED = ['JOINED', 'HIRED'];
const isJoined = (stage) => JOINED.includes(stage);
const CHUNK = 500;

// Applications that are joined and have no day of their own: the day of their latest move into Joined.
async function movesFor(apps) {
  const need = [];
  for (const a of apps) {
    if (a && isJoined(a.stage) && !JD.typedDay(a.joiningDate) && !a.joinedAt) need.push(a.id);
  }
  const out = new Map();
  for (let i = 0; i < need.length; i += CHUNK) {
    // eslint-disable-next-line no-await-in-loop
    const evs = await prisma.applicationStageEvent.findMany({
      where: { applicationId: { in: need.slice(i, i + CHUNK) }, toStage: { in: JOINED } },
      orderBy: { createdAt: 'asc' },
      select: { applicationId: true, createdAt: true },
    });
    evs.forEach((e) => out.set(e.applicationId, e.createdAt));
  }
  return out;
}

// The joining day of one application: null when it is not joined or no day is on file.
function dayOfApp(app, moves, fallbackMoveAt = null) {
  if (!app || !isJoined(app.stage)) return null;
  return JD.joinDay({ joiningDate: app.joiningDate, joinedAt: app.joinedAt }, (moves && moves.get(app.id)) || fallbackMoveAt);
}

// A person's joined applications (the ones this login may see), the one whose day the list shows, and the "joined elsewhere" note.
//   apps       the visible applications: { id, stage, joiningDate, joinedAt, requirement: { title, internal, client: { name } } }
//   primaryId  the application the row shows (its step chip)
// Returns null when the person has no joined application, else:
//   { day, otherDay, other, days }
//   day    the day shown in the Joining date column / sort / export (null = not recorded)
//   other  { applicationId, day, requirementTitle, clientName } when that day belongs to ANOTHER application than the primary one
//   days   every joining day of the person's joined applications (the "Joined between" filter)
function joinInfoOfPerson(apps, primaryId, moves) {
  const joined = [];
  for (const a of apps || []) {
    if (a && isJoined(a.stage)) joined.push({ a, day: dayOfApp(a, moves) });
  }
  if (!joined.length) return null;
  const prim = joined.find((x) => x.a.id === primaryId) || null;
  // The primary application's own day wins; if it has none (or it is not the joined one) the latest day among the others.
  let pick = prim && prim.day ? prim : null;
  if (!pick) {
    pick = joined.filter((x) => x.day).sort((x, y) => (x.day < y.day ? 1 : x.day > y.day ? -1 : 0))[0] || prim || joined[0];
  }
  const days = joined.map((x) => x.day).filter(Boolean);
  let other = null;
  if (pick.a.id !== primaryId && pick.day) {
    const r = pick.a.requirement || null;
    other = {
      applicationId: pick.a.id,
      day: pick.day,
      requirementTitle: r ? r.title || null : null,
      clientName: r ? (r.internal ? 'TeamLink (internal)' : (r.client && r.client.name) || null) : null,
    };
  }
  return { day: pick.day || null, other, days };
}

module.exports = { movesFor, dayOfApp, joinInfoOfPerson, isJoined, JOINED };
