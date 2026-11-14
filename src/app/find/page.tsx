import { permanentRedirect } from 'next/navigation';

// #804 slice 1 shipped the find-a-doctor page here; it is now the home page.
export default function FindDoctorRedirect(): never {
  permanentRedirect('/');
}
