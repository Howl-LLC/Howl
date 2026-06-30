-- AddForeignKey
ALTER TABLE "DMMessage" ADD CONSTRAINT "DMMessage_replyToMessageId_fkey" FOREIGN KEY ("replyToMessageId") REFERENCES "DMMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;
