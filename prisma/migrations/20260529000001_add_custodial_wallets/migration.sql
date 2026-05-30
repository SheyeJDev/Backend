-- CreateTable
CREATE TABLE "custodial_wallets" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "encryptedSecret" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "authTag" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "custodial_wallets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "custodial_wallets_userId_key" ON "custodial_wallets"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "custodial_wallets_publicKey_key" ON "custodial_wallets"("publicKey");

-- CreateIndex
CREATE INDEX "custodial_wallets_userId_idx" ON "custodial_wallets"("userId");
