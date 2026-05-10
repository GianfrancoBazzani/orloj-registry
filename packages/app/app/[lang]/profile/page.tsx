import { Suspense } from "react";
import { Profile } from "@/components/profile";

export default function ProfilePage() {
  return (
    <Suspense>
      <Profile />
    </Suspense>
  );
}
