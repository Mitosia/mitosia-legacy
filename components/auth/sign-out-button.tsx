"use client";

import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { signOut } from "@/lib/auth-client";

export function SignOutButton() {
  const router = useRouter();
  const [isPending, setIsPending] = useState(false);

  const handleSignOut = useCallback(async () => {
    setIsPending(true);
    await signOut();
    router.push("/sign-in");
  }, [router]);

  return (
    <Button disabled={isPending} onClick={handleSignOut} variant="outline">
      {isPending ? <Spinner /> : null}
      Sign out
    </Button>
  );
}
