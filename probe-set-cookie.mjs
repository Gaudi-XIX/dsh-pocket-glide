/**
 * Isolate one question: does undici's fetch expose `set-cookie` on a 303
 * redirect response when `redirect: 'manual'` is used? inner-auth.js depends
 * on the answer.
 */
import http from 'node:http'

const server = http.createServer((req, res) => {
  res.writeHead(303, {
    location: '/',
    'set-cookie': [
      'dsh-auth-launch=launch-secret; HttpOnly; Path=/; SameSite=Lax',
      'dsh-other=noise; Path=/',
    ],
  })
  res.end()
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const url = `http://127.0.0.1:${port}/?token=launch-token-abc`

const response = await fetch(url, { redirect: 'manual' })
console.log('status:', response.status)
console.log('redirected:', response.redirected)
console.log('type:', response.type)
console.log('set-cookie raw:', JSON.stringify(response.headers.get('set-cookie')))
console.log('all headers:', JSON.stringify([...response.headers]))

const cookies = response.headers.getSetCookie?.() ?? []
console.log('getSetCookie():', JSON.stringify(cookies))

server.close()
