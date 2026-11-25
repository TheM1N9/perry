import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AudioPlayer } from "../../components/ui/media-player";

const NativeContext = window.AudioContext;
const contexts = new Set<AudioContext>();
let decoded = 0;
window.AudioContext = class extends NativeContext {
  constructor(options?: AudioContextOptions) { super(options); contexts.add(this); }
  decodeAudioData(...args: Parameters<AudioContext["decodeAudioData"]>) {
    decoded++;
    return super.decodeAudioData(...args);
  }
};
Object.assign(window, { audioResources: () => ({ decoded, openContexts: [...contexts].filter(context => context.state !== "closed").length }) });

function Fixture() {
  const [players, setPlayers] = useState<Array<{ id: number; src: string }>>([]);
  Object.assign(window, { setAudioPlayers: setPlayers });
  return <main>{players.map(player => <AudioPlayer key={player.id} src={player.src} name={`Fixture ${player.id}`} />)}</main>;
}

createRoot(document.getElementById("root")!).render(<Fixture />);
