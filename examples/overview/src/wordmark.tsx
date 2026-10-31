/**
 * The standing mark, on every slide.
 *
 * NO COMPANY NAME. It carried "by KugelAudio" as a third, quieter segment for
 * a while. Two things killed it: the positioning slide now has curb.js as its
 * headline, so the header was saying the same word twice on the slide that
 * matters most, and the company earns its introduction on the closing slide
 * where it is the thing being bought from. A mark that names everything names
 * nothing.
 *
 * One component rather than three copies: this was pasted into the slide
 * frame, the positioning view and the concepts view, and three copies of the
 * same five lines is three places for them to drift apart.
 */
export function Wordmark() {
  return (
    <p className="wordmark">
      curb.js
      <span className="wordmark-note">open source</span>
    </p>
  );
}
