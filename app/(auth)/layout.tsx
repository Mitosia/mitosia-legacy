export default function AuthLayout({ children }: LayoutProps<"/">) {
  return (
    <div className="flex min-h-svh flex-1 flex-col items-center justify-center bg-muted/40 p-6">
      <div className="w-full max-w-sm">{children}</div>
    </div>
  );
}
