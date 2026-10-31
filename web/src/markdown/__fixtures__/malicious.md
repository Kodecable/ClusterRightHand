# Malicious markdown fixture

This document tries every injection vector the agent output could contain.

<script>window.__pwned = true; document.title = "pwned";</script>

<img src=x onerror="fetch('http://127.0.0.1:__BEACON_PORT__/beacon?src=html-onerror')">

<iframe src="http://127.0.0.1:__BEACON_PORT__/beacon?src=iframe" width="400" height="60"></iframe>

<a href="javascript:fetch('http://127.0.0.1:__BEACON_PORT__/beacon?src=raw-js')">raw javascript anchor</a>

<img src="http://127.0.0.1:__BEACON_PORT__/beacon?src=html-img" alt="html img">

Inline <img src=x onerror="fetch('http://127.0.0.1:__BEACON_PORT__/beacon?src=inline-onerror')"> inside a paragraph.

## Markdown links

[javascript link](javascript:alert(1))

[case trick](JaVaScRiPt:alert(2))

[leading space]( javascript:alert(3))

[entity trick](jav&#x61;script:alert(4))

[decimal entity](jav&#97;script:alert(5))

[data url](data:text/html,<script>alert(6)</script>)

[file url](file:///etc/passwd)

[vbscript url](vbscript:msgbox(7))

## Images and autolinks

![beacon image](http://127.0.0.1:__BEACON_PORT__/beacon?src=md-image)

[beacon link](http://127.0.0.1:__BEACON_PORT__/beacon?src=md-link)

Autolink: <http://127.0.0.1:__BEACON_PORT__/beacon?src=autolink>

Bare URL: http://127.0.0.1:__BEACON_PORT__/beacon?src=bare

## A benign link that must survive

[the runbook](https://runbooks.acme.internal/clusterright/hand) and
[mail us](mailto:oncall@acme.internal).
