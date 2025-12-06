-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_BulkOrderUpload" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "customerId" TEXT NOT NULL,
    "customerName" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderLegacyId" TEXT,
    "orderName" TEXT DEFAULT '',
    "totalQuantity" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_BulkOrderUpload" ("createdAt", "customerId", "customerName", "id", "orderId", "orderLegacyId", "orderName", "totalQuantity") SELECT "createdAt", "customerId", "customerName", "id", "orderId", "orderLegacyId", "orderName", "totalQuantity" FROM "BulkOrderUpload";
DROP TABLE "BulkOrderUpload";
ALTER TABLE "new_BulkOrderUpload" RENAME TO "BulkOrderUpload";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
