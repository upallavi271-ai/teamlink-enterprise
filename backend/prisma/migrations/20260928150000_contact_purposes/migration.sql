-- Contact purposes added by users (Contact button -> "Why are you contacting them?"),
-- on top of the built-in list in utils/followups.js. Additive only.
CREATE TABLE "ContactPurpose" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "audience" TEXT NOT NULL DEFAULT 'candidate',
    "label" TEXT NOT NULL,
    "template" TEXT,
    "createdById" TEXT,
    "createdByName" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "ContactPurpose_audience_label_key" ON "ContactPurpose"("audience", "label");
