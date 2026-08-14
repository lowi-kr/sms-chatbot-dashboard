export async function onRequest() {
  return new Response('hello from a function', {
    headers: { 'content-type': 'text/plain' },
  });
}
