import { Explore } from "@/components/explore";
import { fetchMcps } from "@/lib/registry-mcps";

export default async function ExplorePage() {
  const mcps = await fetchMcps();
  return <Explore mcps={mcps} />;
}
