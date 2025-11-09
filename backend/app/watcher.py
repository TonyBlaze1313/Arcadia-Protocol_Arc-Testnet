import asyncio
from web3 import Web3
import os
from dotenv import load_dotenv
from .ai_agent import AiAgent
import json

load_dotenv()

# Use Websocket provider when possible for event subscriptions
ARC_WS = os.getenv("ARC_WS") or os.getenv("ARC_RPC")
if ARC_WS and ARC_WS.startswith("http"):
    # try to convert to ws if possible; but fallback to HTTP
    ARC_RPC = os.getenv("ARC_RPC", ARC_WS)
else:
    ARC_RPC = os.getenv("ARC_RPC", "https://rpc.testnet.arc.network")

# Contract addresses from env (fill after deploy)
ARCADIA_PAY = os.getenv("ARCADIA_PAY_ADDRESS")
USDC_ADDRESS = os.getenv("USDC_ADDRESS")

# Load ABI path if present (assumes compiled artifacts copied to backend/artifacts)
# For demo, include a minimal ABI for events we need
ARCADIA_PAY_ABI = [
    {
      "anonymous": False,
      "inputs": [
        {"indexed": True, "internalType": "uint256", "name": "id", "type": "uint256"},
        {"indexed": True, "internalType": "address", "name": "issuer", "type": "address"},
        {"indexed": True, "internalType": "address", "name": "payer", "type": "address"},
        {"indexed": False, "internalType": "uint256", "name": "amount", "type": "uint256"},
        {"indexed": False, "internalType": "address", "name": "token", "type": "address"},
        {"indexed": False, "internalType": "string", "name": "metadataURI", "type": "string"}
      ],
      "name": "InvoiceCreated",
      "type": "event"
    },
    {
      "anonymous": False,
      "inputs": [
        {"indexed": True, "internalType": "uint256", "name": "id", "type": "uint256"},
        {"indexed": True, "internalType": "address", "name": "payer", "type": "address"},
        {"indexed": False, "internalType": "uint256", "name": "amount", "type": "uint256"},
        {"indexed": False, "internalType": "uint256", "name": "fee", "type": "uint256"}
      ],
      "name": "InvoicePaid",
      "type": "event"
    },
    {
      "anonymous": False,
      "inputs": [
        {"indexed": True, "internalType": "uint256", "name": "id", "type": "uint256"}
      ],
      "name": "InvoiceReleased",
      "type": "event"
    },
    {
      "anonymous": False,
      "inputs": [
        {"indexed": True, "internalType": "uint256", "name": "id", "type": "uint256"}
      ],
      "name": "InvoiceRefunded",
      "type": "event"
    }
]

# web3 provider
w3 = Web3(Web3.HTTPProvider(ARC_RPC))
# create contract wrapper if address provided
contract = None
if ARCADIA_PAY:
    contract = w3.eth.contract(address=Web3.to_checksum_address(ARCADIA_PAY), abi=ARCADIA_PAY_ABI)

agent = AiAgent()

async def start_watcher():
    print("starting watcher against", ARC_RPC)
    # If contract address known: use polling of new blocks but decode logs for events
    # If websocket available, we could subscribe; for portability use polling
    last_block = w3.eth.block_number
    while True:
        try:
            block = w3.eth.get_block('latest', full_transactions=False)
            if block and block.number > last_block:
                latest = block.number
                for bn in range(last_block + 1, latest + 1):
                    blk = w3.eth.get_block(bn, full_transactions=True)
                    # notify agent about new block
                    await agent.on_new_block(blk)
                    # if contract known, decode events from block logs
                    if contract:
                        for tx in blk['transactions']:
                            try:
                                receipt = w3.eth.get_transaction_receipt(tx)
                                for log in receipt['logs']:
                                    try:
                                        ev = contract.events.InvoiceCreated().processLog(log)
                                        print("InvoiceCreated:", ev['args'])
                                        await agent.on_event("InvoiceCreated", dict(ev['args']))
                                    except Exception:
                                        pass
                                    try:
                                        ev = contract.events.InvoicePaid().processLog(log)
                                        print("InvoicePaid:", ev['args'])
                                        await agent.on_event("InvoicePaid", dict(ev['args']))
                                    except Exception:
                                        pass
                                    try:
                                        ev = contract.events.InvoiceReleased().processLog(log)
                                        print("InvoiceReleased:", ev['args'])
                                        await agent.on_event("InvoiceReleased", dict(ev['args']))
                                    except Exception:
                                        pass
                                    try:
                                        ev = contract.events.InvoiceRefunded().processLog(log)
                                        print("InvoiceRefunded:", ev['args'])
                                        await agent.on_event("InvoiceRefunded", dict(ev['args']))
                                    except Exception:
                                        pass
                            except Exception as e:
                                # ignore tx receipt decode errors
                                pass
                last_block = latest
        except Exception as e:
            print("watcher error", e)
        await asyncio.sleep(2)
