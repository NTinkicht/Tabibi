import { GuestLiveQueueHostClient } from './GuestLiveQueueHostClient';

type Props = {
  params: Promise<{ selectionReference: string }>;
};

export default async function GuestLiveQueuePage({ params }: Props) {
  const { selectionReference } = await params;
  return (
    <main>
      <GuestLiveQueueHostClient selectionReference={selectionReference} />
    </main>
  );
}
