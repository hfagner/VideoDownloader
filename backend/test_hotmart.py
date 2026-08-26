import requests, re, base64, json

# Embed URL real (com token valido) — pegar da extensao
embed_url = 'https://cf-embed.play.hotmart.com/embed/2qYw75xWZB?applicationCode=f57b1bb2-30e3-4fd0-9c59-cfe00909f280&userCode=3eawAwBmOg&jwtToken=eyJhbGciOiJSUzUxMiJ9.eyJlZGl0TWFya2VyIjpmYWxzZSwiZGVzY3JpcHRpb24iOiJGYWl4YSBCcmFuY2EgLSBDb21lY2UgcG9yIGFxdWkgfCBBdWxhIDIuNyAtIEJhbGPDo28gSW5maW5pdHkiLCJ0aXRsZSI6IlRyZWluYW1lbnRvIEdlc3RvciBkZSBNaWxoYXMgLSBSb2RyaWdvIEdvZXMuIiwibWVkaWFDb2RlIjoiMnFZdzc1eFdaQiIsInVzZXJJZCI6IjMzMjk4ODU0IiwidXNlckNvZGUiOiIzZWF3QXdCbU9nIiwicGxheURybSI6ZmFsc2UsInN1YiI6ImY1N2IxYmIyLTMwZTMtNGZkMC05YzU5LWNmZTAwOTA5ZjI4MCIsImV4cCI6MTc4NzY4NjA5MSwiaWF0IjoxNzg3NTk5NjkxfQ.dummy'

from urllib.parse import urlparse, parse_qs
params = parse_qs(urlparse(embed_url).query)
jwt = params.get('jwtToken', [''])[0]
app_code = params.get('applicationCode', [''])[0]
media_code = urlparse(embed_url).path.split('/')[-1]
print('mediaCode:', media_code)
print('applicationCode:', app_code)

# Decodifica o JWT (sem verificar assinatura)
try:
    payload_b64 = jwt.split('.')[1]
    payload_b64 += '=' * (4 - len(payload_b64) % 4)
    payload = json.loads(base64.b64decode(payload_b64))
    print('JWT payload:', json.dumps(payload, indent=2))
except Exception as e:
    print('JWT decode error:', e)

# Tenta a API do Hotmart Player
# A API real usa: https://contentplayer.hotmart.com/video/{mediaCode}/signed
api_url = f'https://contentplayer.hotmart.com/video/{media_code}/signed'
headers = {
    'User-Agent': 'Mozilla/5.0',
    'Origin': 'https://cf-embed.play.hotmart.com',
    'Referer': 'https://cf-embed.play.hotmart.com/',
    'Authorization': f'Bearer {jwt}',
}
r = requests.get(api_url, headers=headers, timeout=10)
print('API Status:', r.status_code)
print('API Response:', r.text[:500])
