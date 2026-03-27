"""
EV Digital Twin - Fleet Management Backend
Flask server providing multi-vehicle telemetry and independent RL agents.
"""

from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS
import math
import time
import random
import os

app = Flask(__name__, static_folder='.', static_url_path='')
CORS(app)

# ---------------------------------------------------------------------------
# RL Agent Multi-Instancing
# ---------------------------------------------------------------------------
RL_AGENTS = {}
rl_available = False

try:
    from rl_agent import DQNAgent
    rl_available = True
    print("🧠 RL Agent class loaded (Multi-instance ready)")
except ImportError as e:
    print(f"⚠️  RL Agent not available (PyTorch not installed): {e}")

# ---------------------------------------------------------------------------
# Fleet Configuration
# ---------------------------------------------------------------------------
VEHICLE_IDS = ["EV-Alpha", "EV-Beta", "EV-Gamma"]

# Mode profiles
MODE_PROFILES = {
    "eco":    {"rpm_base": 2500, "rpm_range": 1500, "temp_base": 40, "temp_range": 15, "drain_rate": 0.02},
    "normal": {"rpm_base": 3500, "rpm_range": 2000, "temp_base": 50, "temp_range": 20, "drain_rate": 0.04},
    "sport":  {"rpm_base": 5000, "rpm_range": 3000, "temp_base": 60, "temp_range": 30, "drain_rate": 0.06},
    "wet":    {"rpm_base": 2800, "rpm_range": 1200, "temp_base": 42, "temp_range": 12, "drain_rate": 0.03},
}

THROTTLE_MULTIPLIER = {"low": 0.6, "high": 1.0}

# Initialize vehicle states
VEHICLES = {}
for vid in VEHICLE_IDS:
    VEHICLES[vid] = {
        "id": vid,
        "battery": random.uniform(70.0, 95.0),
        "rpm": 0,
        "temp": 30.0,
        "mode": random.choice(["eco", "normal"]),
        "throttle": "high",
        "running": True,
        "start_time": time.time(),
        "last_update": time.time(),
        "override_rpm": None,
        "override_temp": None,
        "step_counter": 0,
        "last_ai_cmd": {"mode": "eco", "throttle": "low"}
    }
    
    if rl_available:
        RL_AGENTS[vid] = DQNAgent()
        print(f"✅ Created RL agent for {vid}")

def update_vehicle(vid):
    """Step the simulation for a specific vehicle."""
    v = VEHICLES[vid]
    agent = RL_AGENTS.get(vid)
    
    now = time.time()
    elapsed = now - v["start_time"]
    dt = now - v["last_update"]
    v["last_update"] = now

    # Reset last_update if it was zero or from previous run
    if dt > 100 or dt < 0:
        dt = 0.05

    if not v["running"]:
        return

    # --- RL Agent step (independent for each car) ---
    if agent and agent.enabled:
        v["step_counter"] += 1
        if v["step_counter"] % 10 == 1:
            action = agent.step(v)
            v["last_ai_cmd"] = agent.get_action_command(action)
            
        cmd = v["last_ai_cmd"]
        v["mode"] = cmd["mode"]
        v["throttle"] = cmd["throttle"]

    profile = MODE_PROFILES[v["mode"]]
    throttle = THROTTLE_MULTIPLIER.get(v["throttle"], 1.0)

    # Battery
    drain = profile["drain_rate"] * throttle * dt + random.uniform(-0.005, 0.005)
    v["battery"] -= drain
    if v["battery"] <= 10: v["battery"] = 98.0  # Simulated recharge
    v["battery"] = max(5.0, min(100.0, v["battery"]))

    # RPM
    if v.get("override_rpm") is not None:
        v["rpm"] = float(v["override_rpm"])
    else:
        rpm = profile["rpm_base"] * throttle + profile["rpm_range"] * throttle * math.sin(elapsed * 0.3)
        rpm += random.uniform(-200, 200)
        v["rpm"] = max(0, round(rpm))

    # Temperature
    if v.get("override_temp") is not None:
        v["temp"] = float(v["override_temp"])
    else:
        temp = profile["temp_base"] + profile["temp_range"] * throttle * (0.5 + 0.5 * math.sin(elapsed * 0.15))
        temp += random.uniform(-1, 1)
        v["temp"] = round(max(20, min(120, temp)), 1)

# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
@app.route('/')
def index():
    return send_from_directory('.', 'fleet.html')

@app.route('/twin')
def twin():
    return send_from_directory('.', 'index.html')

@app.route('/fleet')
def fleet_summary():
    """Return summary of all vehicles."""
    summary = []
    for vid in VEHICLE_IDS:
        update_vehicle(vid)
        v = VEHICLES[vid]
        summary.append({
            "id": vid,
            "battery": round(v["battery"], 1),
            "rpm": v["rpm"],
            "temp": v["temp"],
            "mode": v["mode"],
            "running": v["running"],
            "ai_enabled": RL_AGENTS[vid].enabled if vid in RL_AGENTS else False
        })
    return jsonify(summary)

@app.route('/data/<vid>')
def vehicle_data(vid):
    """Return detailed telemetry for one vehicle."""
    if vid not in VEHICLES:
        return jsonify({"error": "Vehicle not found"}), 404
    update_vehicle(vid)
    v = VEHICLES[vid]
    return jsonify({
        "id": vid,
        "battery": round(v["battery"], 1),
        "rpm": v["rpm"],
        "temp": v["temp"],
        "mode": v["mode"],
        "running": v["running"],
        "ai_enabled": RL_AGENTS[vid].enabled if vid in RL_AGENTS else False,
    })

@app.route('/mode/<vid>', methods=['POST'])
def set_mode(vid):
    if vid not in VEHICLES: return jsonify({"error": "Not found"}), 404
    body = request.get_json(force=True)
    mode = body.get("mode", "eco").lower()
    if mode in MODE_PROFILES:
        VEHICLES[vid]["mode"] = mode
        if vid in RL_AGENTS: RL_AGENTS[vid].enabled = False
    return jsonify({"mode": VEHICLES[vid]["mode"]})

@app.route('/override/<vid>', methods=['POST'])
def override_state(vid):
    if vid not in VEHICLES: return jsonify({"error": "Not found"}), 404
    body = request.get_json(force=True)
    v = VEHICLES[vid]
    if "rpm" in body:
        val = body["rpm"]
        v["override_rpm"] = float(val) if val is not None else None
    if "temp" in body:
        val = body["temp"]
        v["override_temp"] = float(val) if val is not None else None
    return jsonify({"success": True})

@app.route('/control/<vid>', methods=['POST'])
def control(vid):
    if vid not in VEHICLES: return jsonify({"error": "Not found"}), 404
    body = request.get_json(force=True)
    action = body.get("action", "toggle")
    v = VEHICLES[vid]
    if action == "start": v["running"] = True
    elif action == "stop": v["running"] = False
    else: v["running"] = not v["running"]
    return jsonify({"running": v["running"]})

@app.route('/rl/status/<vid>')
def rl_status(vid):
    if vid not in RL_AGENTS: return jsonify({"available": False})
    status = RL_AGENTS[vid].get_status()
    status["available"] = True
    return jsonify(status)

@app.route('/rl/control/<vid>', methods=['POST'])
def rl_control(vid):
    if vid not in RL_AGENTS: return jsonify({"available": False})
    body = request.get_json(force=True)
    action = body.get("action", "toggle")
    agent = RL_AGENTS[vid]
    if action == "enable": agent.enabled = True
    elif action == "disable": agent.enabled = False
    else: agent.enabled = not agent.enabled
    return jsonify({"enabled": agent.enabled})

@app.route('/<path:path>')
def static_files(path):
    return send_from_directory('.', path)

if __name__ == '__main__':
    print("🚗  EV Fleet Dashboard starting on http://localhost:5000")
    app.run(host='0.0.0.0', port=5000, debug=True)
