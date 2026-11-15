import { GuestServiceWorker } from '../../GuestServiceWorker';
import { GuestNotificationCenterClient } from './GuestNotificationCenterClient';
import { GuestStatusClient } from './GuestStatusClient';

export default function GuestStatusPage() {
  return (
    <main>
      <GuestServiceWorker />
      <GuestStatusClient />
      <GuestNotificationCenterClient />
    </main>
  );
}
