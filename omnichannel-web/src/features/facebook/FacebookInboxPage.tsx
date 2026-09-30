import { Facebook } from 'lucide-react';
import { MetaDmInbox } from './MetaDmInbox';

/**
 * Facebook Messages — the Page's Messenger threads.
 *
 * Inbound arrives by webhook (see the Messenger handler in the API); replies go
 * out through the Send API as the Page. The inbox itself — list, thread,
 * composer, 24-hour window — is MetaDmInbox, shared with Instagram.
 */
export function FacebookInboxPage() {
  return (
    <MetaDmInbox
      channel="facebook"
      queryKeyPrefix="fb"
      icon={Facebook}
      iconClassName="text-blue"
      title="Facebook Messages"
      subtitle="Conversations from your connected Facebook Page."
      contactFallback="Messenger user"
      threadCaption="Messenger · via your Facebook Page"
      emptyListDetail="Messages people send to your Page land here. They arrive by webhook, so the Page must be subscribed and the callback reachable."
      placeholderTitle="Facebook Direct Messages"
      windowOpenHint={(h) => `Facebook allows a free reply for about ${h} more hour${h === 1 ? '' : 's'} — the window runs 24h from their last message.`}
      windowClosed={(
        <>
          <span className="font-semibold">The 24-hour reply window has closed.</span> Facebook only lets a Page
          reply freely within 24 hours of the person’s last message. They need to message the Page again before
          you can respond — sending now would be refused.
        </>
      )}
    />
  );
}
