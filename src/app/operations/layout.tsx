import { SignOutControl } from './sign-out-control';

export default function OperationsLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <>
      <SignOutControl />
      {children}
    </>
  );
}
