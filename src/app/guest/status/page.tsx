import { GuestNotificationCenterClient } from './GuestNotificationCenterClient';
import { GuestStatusClient } from './GuestStatusClient';

export default function GuestStatusPage() {
  return (
    <main>
      <GuestStatusClient />
      <GuestNotificationCenterClient />
    </main>
  );
}
