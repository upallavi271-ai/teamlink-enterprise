import { Instagram } from 'lucide-react';
import { MetaDmInbox } from '@/features/facebook/MetaDmInbox';
import { useCan } from '@/features/auth/useCan';
import { InstagramMessagingChecklist } from './InstagramMessagingChecklist';

/** Instagram's own limit on one message: "1,000 bytes or less", UTF-8. */
const INSTAGRAM_MAX_BYTES = 1000;

/**
 * Instagram Direct — messages people send to the Instagram professional account
 * linked to the connected Facebook Page (after seeing a post, replying to a
 * story, or just writing in).
 *
 * Inbound arrives by webhook (object "instagram") and is routed to this
 * workspace only if this workspace connected that Instagram account. Replies go
 * out as the account through the Page token, inside Meta's 24-hour window —
 * the API refuses anything outside it with a reason, and so does the composer.
 */
export function InstagramInboxPage() {
  // The checklist's endpoints need integration.manage; agents who only reply
  // see the inbox without it.
  const canManage = useCan('integration.manage');
  return (
    <MetaDmInbox
      channel="instagram"
      queryKeyPrefix="ig"
      icon={Instagram}
      iconClassName="text-violet"
      title="Instagram Messages"
      subtitle="Direct messages to the Instagram account linked to your Facebook Page."
      contactFallback="Instagram user"
      threadCaption="Instagram Direct · via your linked Facebook Page"
      emptyListDetail={canManage
        ? 'Direct messages to your Instagram professional account land here. They arrive by webhook — see the setup checklist above for what is still missing.'
        : 'Direct messages to your Instagram professional account land here. They arrive by webhook once an admin finishes the Instagram messaging setup in Settings.'}
      placeholderTitle="Instagram Direct Messages"
      windowOpenHint={(h) => `Instagram allows a reply for about ${h} more hour${h === 1 ? '' : 's'} — the window runs 24h from their last message.`}
      windowClosed={(
        <>
          <span className="font-semibold">The 24-hour reply window has closed.</span> Instagram only lets a business
          reply within 24 hours of the person’s last message. They need to message your account again before you
          can respond — sending now would be refused.
        </>
      )}
      maxBytes={INSTAGRAM_MAX_BYTES}
      banner={canManage ? <InstagramMessagingChecklist compact /> : undefined}
    />
  );
}
