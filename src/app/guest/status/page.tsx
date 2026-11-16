import { GuestServiceWorker } from '../../GuestServiceWorker';
import { GuestNotificationCenterClient } from './GuestNotificationCenterClient';
import { GuestPushCard } from './GuestPushCard';
import { GuestStatusClient } from './GuestStatusClient';

export default function GuestStatusPage() {
  return (
    <main>
      <GuestServiceWorker />
      <GuestStatusClient />
      <GuestPushCard />
      <GuestNotificationCenterClient />
    </main>
  );
}
