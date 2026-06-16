-- CreateTable
CREATE TABLE "Tagger" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shop" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tag" TEXT NOT NULL,
    "startDate" DATETIME,
    "endDate" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "TaggerCustomer" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "taggerId" INTEGER NOT NULL,
    "email" TEXT NOT NULL,
    CONSTRAINT "TaggerCustomer_taggerId_fkey" FOREIGN KEY ("taggerId") REFERENCES "Tagger" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "Tagger_shop_idx" ON "Tagger"("shop");

-- CreateIndex
CREATE INDEX "TaggerCustomer_email_idx" ON "TaggerCustomer"("email");
