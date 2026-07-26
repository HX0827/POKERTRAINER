import { PokerTrainer } from "./components/PokerTrainer";
import { startHand } from "./lib/poker";

export default function Home() {
  return <PokerTrainer initialGame={startHand()} />;
}
