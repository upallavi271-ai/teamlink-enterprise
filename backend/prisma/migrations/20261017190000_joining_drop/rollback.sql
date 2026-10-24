-- Rollback of 20261017190000_joining_drop (the joining records, their history and the notice log are deleted; nothing else is touched)
DROP TABLE IF EXISTS "JoinDropNotice";
DROP TABLE IF EXISTS "JoiningEvent";
DROP TABLE IF EXISTS "JoiningRecord";
