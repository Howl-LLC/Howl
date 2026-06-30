-- AlterTable
ALTER TABLE "ServerMember" ADD COLUMN     "roleId" TEXT;

-- CreateTable
CREATE TABLE "ServerRole" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#99aab5',
    "style" TEXT NOT NULL DEFAULT 'solid',
    "icon" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "permissions" JSONB,
    "displaySeparately" BOOLEAN NOT NULL DEFAULT false,
    "allowMention" BOOLEAN NOT NULL DEFAULT false,
    "linkedRoleRequirements" JSONB,
    "locked" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ServerRole_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ServerRole_serverId_idx" ON "ServerRole"("serverId");

-- CreateIndex
CREATE INDEX "ServerMember_roleId_idx" ON "ServerMember"("roleId");

-- AddForeignKey
ALTER TABLE "ServerRole" ADD CONSTRAINT "ServerRole_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServerMember" ADD CONSTRAINT "ServerMember_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "ServerRole"("id") ON DELETE SET NULL ON UPDATE CASCADE;
