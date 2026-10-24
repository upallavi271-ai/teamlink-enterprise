-- CreateTable
CREATE TABLE "EmployeeIdea" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "employeeId" TEXT,
    "authorName" TEXT NOT NULL,
    "department" TEXT,
    "title" TEXT NOT NULL,
    "details" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "titleKey" TEXT NOT NULL,
    "tokens" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'New',
    "rdNote" TEXT,
    "reviewedBy" TEXT,
    "reviewedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "EmployeeIdea_userId_month_idx" ON "EmployeeIdea"("userId", "month");

-- CreateIndex
CREATE INDEX "EmployeeIdea_month_idx" ON "EmployeeIdea"("month");
