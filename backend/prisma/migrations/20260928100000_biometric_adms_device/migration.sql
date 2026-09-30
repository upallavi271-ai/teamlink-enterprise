-- Biometric device (eSSL ADMS / iClock push). Additive only.

CREATE TABLE "BiometricDevice" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "vendor" TEXT NOT NULL,
    "protocol" TEXT NOT NULL DEFAULT 'ADMS/iClock',
    "serialNumber" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "port" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'Active',
    "lastSeenAt" DATETIME,
    "lastSeenIp" TEXT,
    "lastRequest" TEXT,
    "deviceInfo" TEXT,
    "attlogStamp" TEXT,
    "punchesReceived" INTEGER NOT NULL DEFAULT 0,
    "lastPunchAt" TEXT,
    "createdById" TEXT,
    "updatedById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "BiometricDevice_serialNumber_key" ON "BiometricDevice"("serialNumber");

CREATE TABLE "BiometricPunchLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deviceSerial" TEXT NOT NULL,
    "pin" TEXT NOT NULL,
    "punchAt" TEXT NOT NULL,
    "statusCode" TEXT,
    "verifyCode" TEXT,
    "raw" TEXT,
    "employeeId" TEXT,
    "attendancePunchId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "BiometricPunchLog_deviceSerial_pin_punchAt_key" ON "BiometricPunchLog"("deviceSerial", "pin", "punchAt");
CREATE INDEX "BiometricPunchLog_pin_idx" ON "BiometricPunchLog"("pin");

CREATE TABLE "BiometricDeviceUser" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deviceSerial" TEXT NOT NULL,
    "pin" TEXT NOT NULL,
    "name" TEXT,
    "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "BiometricDeviceUser_deviceSerial_pin_key" ON "BiometricDeviceUser"("deviceSerial", "pin");

ALTER TABLE "Employee" ADD COLUMN "biometricPin" TEXT;
CREATE INDEX "Employee_biometricPin_idx" ON "Employee"("biometricPin");
