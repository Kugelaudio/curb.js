# Calls from your website

On KugelAudio, the web widget puts a talk button on your page, with one script tag. Its styling
options and which sites may start calls are in the
[KugelAudio docs](https://docs.kugelaudio.com/hosted-agents/web-widget); hosted agents are in closed
alpha. On your own host, connect your page with [`curb/client`](./client.md).

```html
<script src="https://cdn.kugelaudio.com/widget/v1/widget.js" data-agent="YOUR_WIDGET_ID" async></script>
```

## Tell the agent where a call comes from

Two attributes and a property pass context about the page to the agent, so it knows, for
example, which event a visitor is calling about or who is logged in, without asking. The
dashboard has no setting for them: add them to your page yourself.

- `data-context` is a JSON object written into the tag, such as
  `data-context='{"page":"pricing"}'`.
- `data-context-params` names query parameters of the page's address to copy in, separated
  by commas. With `data-context-params="event,ref"`, a visitor on
  `https://example.com/call?event=webinar-11-04&ref=newsletter` brings `event` and `ref`
  along. The widget reads only the parameters you name, never the rest of the address.
- The widget's `context` property sets that JSON object from your page's script, for what
  the page learns after it loads, such as who has logged in:
  `widget.context = { email: user.email }`, where `widget` is
  `document.querySelector('kugelaudio-agent')`. The next call to start carries it in place of
  the tag's `data-context` (`{ ...widget.context, email: user.email }` keeps both). It stays
  in the page's memory and is never written into its HTML, so a session recording, which
  captures the HTML, does not capture the email. `null` clears it, and `data-context` applies
  again.

```html
<script src="https://cdn.kugelaudio.com/widget/v1/widget.js"
  data-agent="YOUR_WIDGET_ID"
  data-context='{"page":"pricing"}'
  data-context-params="event,ref"
  async></script>
```

A key in `data-context` or the `context` property wins over a parameter of the same name,
and a parameter that is missing or empty is left out. The agent reads each key as
`client.<key>`, for example `client.event`, from the start of the call, so its greeting can
already use it. The [webinar recipe](./knowing-the-caller.md#tell-the-agent-which-event-a-call-comes-from)
shows the agent's side.

The limits:

- At most 16 keys. A key starts with a letter and has at most 40 letters, digits and
  underscores.
- A value is a string of at most 256 characters, a number or a boolean. The agent reads a
  number or a boolean as text, for example `"120"`.
- All of it together fits in 8,000 bytes of JSON. Sixteen values of 256 letters and digits
  fit; long values in other scripts may not.
- When the context breaks a limit or `data-context` is not valid JSON, the widget writes the
  reason to the browser console and starts the call without context. The visitor still
  reaches the agent.

Anyone can change a page's address or what its script sets, so treat the context as a hint
from the page: use it to prefill and to skip questions, never as proof of who the visitor is
or to unlock their account's data. Put no email address, name or other personal detail into
a link: use an id that means something only to you, such as `webinar-11-04`. A page that
knows its logged-in visitor passes those through the `context` property instead, as in
[this recipe](./knowing-the-caller.md#pass-what-you-already-know-a-logged-in-user).

## Send a call link in a chat or an email

A link cannot start a call by itself: a browser lets a page use the microphone only after
the visitor clicks. So the link opens a page of yours with the widget on it, and one click
starts the call.

1. Make a page on a website your widget accepts calls from, for example
   `https://example.com/call` (see [which sites can start calls](https://docs.kugelaudio.com/hosted-agents/web-widget#which-sites-can-start-calls)).
2. Put the widget on it inline, so that its button sits in the page. Start from your
   widget's code in the dashboard, which carries every attribute your widget needs, and
   add the inline position, the label and the title:

   ```html
   <!doctype html>
   <html lang="en">
     <head>
       <meta charset="utf-8">
       <meta name="viewport" content="width=device-width, initial-scale=1">
       <title>Talk to our assistant</title>
     </head>
     <body>
       <main>
         <h1>Talk to our assistant</h1>
         <p>Press the button and allow your microphone.</p>
         <div data-kugelaudio-widget></div>
       </main>

       <script src="https://cdn.kugelaudio.com/widget/v1/widget.js"
         data-agent="YOUR_WIDGET_ID"
         data-position="inline"
         data-size="lg"
         data-label="Start the call"
         data-title="Our assistant"
         async></script>
     </body>
   </html>
   ```

3. Send the page's address in your chat or email.

`data-label` is the button's text and `data-title` the heading of the call panel that
opens from it. The visitor's click on that button starts the call. A button of your own
design can start it too, by calling the widget's `start()`; see
[Start a call from your own button](https://docs.kugelaudio.com/hosted-agents/web-widget#start-a-call-from-your-own-button).

## Show a recording notice before the call

The widget has no consent step: a click on its button starts the call. Put your notice
on the page above the button, so that visitors read it before they click. No call starts
and no microphone opens before that click.

Whether a call is recorded is decided when the call starts, by the agent's
**Settings** > **Recording and retention**. A call that starts while the agent keeps
nothing has no transcript, audio or activity afterwards. Write the notice to match what
that section says.

```html
<p>
  This call is recorded and transcribed so that we can help you. Our
  <a href="https://example.com/privacy">privacy policy</a> says how long we keep it.
</p>
<div data-kugelaudio-widget></div>
```

To ask for an explicit yes, show the button only once the visitor agrees. Keep the
widget's script tag with `data-position="inline"` on the page: the widget also fills a
`data-kugelaudio-widget` element that is added later.

```html
<label><input type="checkbox" id="agree"> I agree that this call is recorded.</label>
<div id="call"></div>

<script>
  document.getElementById('agree').addEventListener('change', (event) => {
    const call = document.getElementById('call')
    if (!event.target.checked || call.firstChild) return
    const spot = document.createElement('div')
    spot.setAttribute('data-kugelaudio-widget', '')
    call.append(spot)
  })
</script>
```

A phone call has no page. Let the agent speak first on a call (`firstTurn: "agent"` in
`src/agent/agent.tsx`, as the template has it) and tell it in its `<SystemPrompt>` to say
that the call is recorded before anything else. The model says it in its own words.

## Next steps

- [Knowing the caller](./knowing-the-caller.md): read the context in the agent.
