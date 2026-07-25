import { Sentiment } from "@/components/sentiment";

// Client component: the reading is fetched from /api/sentiment on mount and refreshed
// on an interval, rather than server-rendered. A live chain read takes 3-7s, so
// blocking the page render on it would make navigation feel broken.
export default function SentimentPage() {
  return <Sentiment />;
}
