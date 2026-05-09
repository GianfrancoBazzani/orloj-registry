import { Suspense } from "react";
import { Explore } from "@/components/explore";

export default function ExplorePage() {
  return (
    <Suspense>
      <Explore />
    </Suspense>
  );
}
