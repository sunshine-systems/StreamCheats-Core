// Home page — at SC-6 this is just an "implementation pending" stub.
// SC-7 wires the real content: device connection status, unseen
// errors/warnings badge, software update banner.

import PendingStub from "../components/ui/PendingStub";

export default function HomePage() {
  return (
    <PendingStub
      eyebrow="home · status"
      title="Home"
      ticket="SC-7"
      blurb="Device connection status, recent errors, and update notices land here."
    />
  );
}
