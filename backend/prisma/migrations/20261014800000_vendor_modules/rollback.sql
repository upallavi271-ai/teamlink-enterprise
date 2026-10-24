-- Undo 20261014800000_vendor_modules. Drops ONLY the tables it created (data in them is lost).
DROP TABLE IF EXISTS "VendorModuleBill";
DROP TABLE IF EXISTS "SimRequest";
DROP TABLE IF EXISTS "SimConnection";
DROP TABLE IF EXISTS "IdCardOrderEvent";
DROP TABLE IF EXISTS "IdCardOrderLine";
DROP TABLE IF EXISTS "IdCardOrder";
DROP TABLE IF EXISTS "VendorLoginModule";
-- If Prisma's migration table was updated: DELETE FROM "_prisma_migrations" WHERE migration_name = '20261014800000_vendor_modules';
