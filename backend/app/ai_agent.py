import asyncio
import time
import os
import requests

WEBHOOK = os.getenv("ALERT_WEBHOOK")  # optional external webhook

class AiAgent:
    def __init__(self):
        # simple in-memory alert log for demo
        self.alerts = []

    async def on_new_block(self, block):
        tx_count = len(block.get('transactions', []))
        print(f"[agent] new block {block['number']} txs={tx_count}")
        if tx_count > 1000:
            alert = {"ts": time.time(), "level": "warning", "msg": f"high activity block {block['number']} txs={tx_count}"}
            self._push_alert(alert)
        await asyncio.sleep(0)

    async def on_event(self, event_name, args):
        print(f"[agent] event {event_name} args={args}")
        # naive heuristics
        if event_name == "InvoicePaid":
            fee = args.get("fee", 0)
            amount = args.get("amount", 0)
            if fee and fee > 0 and (fee * 100) / (amount + 1) > 500:  # >5% (very naive)
                alert = {"ts": time.time(), "level": "info", "msg": f"High fee detected invoice {args.get('id')}"}
                self._push_alert(alert)
        await asyncio.sleep(0)

    def _push_alert(self, alert):
        self.alerts.append(alert)
        print("[agent][alert]", alert)
        # optionally forward to webhook
        if WEBHOOK:
            try:
                requests.post(WEBHOOK, json=alert, timeout=3)
            except Exception as e:
                print("webhook forward failed", e)
