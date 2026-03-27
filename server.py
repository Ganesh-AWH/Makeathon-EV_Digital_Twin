"""
EV Digital Twin - Backend Server
Flask server providing simulated EV telemetry data, RL agent integration,
and serving the frontend.
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
# RL Agent (lazy-loaded to handle missing PyTorch gracefully)
# ---------------------------------------------------------------------------
rl_agent = None
rl_available = False

try:
    from rl_agent import DQNAgent
    rl_agent = DQNAgent()
    rl_available = True
    print("🧠 RL Agent initialized (DQN with PyTorch)")
except ImportError as e:
    print(f"⚠️  RL Agent not available (PyTorch not installed): {e}")
except Exception as e:
    print(f"⚠️  RL Agent initialization failed: {e}")

# ---------------------------------------------------------------------------
# Simulation state
# ---------------------------------------------------------------------------
sim_state = {
    "battery": 85.0,
    "rpm": 3000,
    "temp": 45.0,
    "mode": "eco",          # eco | sport
    "running": True,
    "start_time": time.time(),
    "last_update": time.time(),
    "override_rpm": None,
    "override_temp": None,
}

# Mode profiles — throttle variants included for RL
MODE_PROFILES = {
    "eco":    {"rpm_base": 2500, "rpm_range": 1500, "temp_base": 40, "temp_range": 15, "drain_rate": 0.02},
    "normal": {"rpm_base": 3500, "rpm_range": 2000, "temp_base": 50, "temp_range": 20, "drain_rate": 0.04},
    "sport":  {"rpm_base": 5000, "rpm_range": 3000, "temp_base": 60, "temp_range": 30, "drain_rate": 0.06},
    "wet":    {"rpm_base": 2800, "rpm_range": 1200, "temp_base": 42, "temp_range": 12, "drain_rate": 0.03},
}

THROTTLE_MULTIPLIER = {
    "low": 0.6,
    "high": 1.0,
}

# Current throttle (controlled by RL or default)
current_throttle = "high"


def update_simulation():
    """Generate realistic oscillating EV telemetry values."""
    global current_throttle
    now = time.time()
    elapsed = now - sim_state["start_time"]
    dt = now - sim_state["last_update"]
    sim_state["last_update"] = now

    if not sim_state["running"]:
        return

    # --- RL Agent step (if enabled) ---
    if rl_agent and rl_agent.enabled:
        if not hasattr(rl_agent, "step_counter"):
            rl_agent.step_counter = 0
            rl_agent.last_cmd = {"mode": "eco", "throttle": "low"}
            
        rl_agent.step_counter += 1
        if rl_agent.step_counter % 10 == 1:  # decision every ~10 seconds
            action = rl_agent.step(sim_state)
            rl_agent.last_cmd = rl_agent.get_action_command(action)
            
        cmd = rl_agent.last_cmd
        sim_state["mode"] = cmd["mode"]
        current_throttle = cmd["throttle"]

    profile = MODE_PROFILES[sim_state["mode"]]
    throttle = THROTTLE_MULTIPLIER.get(current_throttle, 1.0)

    # Battery: drain rate affected by throttle
    drain = profile["drain_rate"] * throttle * dt + random.uniform(-0.005, 0.005)
    sim_state["battery"] -= drain
    if sim_state["battery"] <= 10:
        sim_state["battery"] = 95.0  # simulate recharge event
    sim_state["battery"] = max(5.0, min(100.0, sim_state["battery"]))

    # RPM: sinusoidal variation scaled by throttle or overridden
    if sim_state.get("override_rpm") is not None:
        sim_state["rpm"] = float(sim_state["override_rpm"])
    else:
        rpm = profile["rpm_base"] * throttle + profile["rpm_range"] * throttle * math.sin(elapsed * 0.3)
        rpm += random.uniform(-200, 200)
        sim_state["rpm"] = max(0, round(rpm))

    # Temperature: correlated with RPM + ambient drift or overridden
    if sim_state.get("override_temp") is not None:
        sim_state["temp"] = float(sim_state["override_temp"])
    else:
        temp = profile["temp_base"] + profile["temp_range"] * throttle * (0.5 + 0.5 * math.sin(elapsed * 0.15))
        temp += random.uniform(-1, 1)
        sim_state["temp"] = round(max(20, min(120, temp)), 1)


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
@app.route('/')
def index():
    return send_from_directory('.', 'index.html')


@app.route('/data')
def data():
    """Return current simulated EV telemetry as JSON."""
    update_simulation()
    return jsonify({
        "battery": round(sim_state["battery"], 1),
        "rpm": sim_state["rpm"],
        "temp": sim_state["temp"],
        "mode": sim_state["mode"],
        "running": sim_state["running"],
        "ai_enabled": rl_agent.enabled if rl_agent else False,
    })


@app.route('/mode', methods=['POST'])
def set_mode():
    """Switch between driving modes."""
    body = request.get_json(force=True)
    mode = body.get("mode", "eco").lower()
    if mode in MODE_PROFILES:
        sim_state["mode"] = mode
        if rl_agent and rl_agent.enabled:
            rl_agent.enabled = False  # Disable AI if user manually clicks a mode
    return jsonify({"mode": sim_state["mode"]})


@app.route('/override', methods=['POST'])
def override_state():
    """Manually override RPM or Temp values for RL agent testing."""
    body = request.get_json(force=True)
    if "rpm" in body:
        val = body["rpm"]
        sim_state["override_rpm"] = float(val) if val is not None else None
    if "temp" in body:
        val = body["temp"]
        sim_state["override_temp"] = float(val) if val is not None else None
    return jsonify({"success": True})


@app.route('/control', methods=['POST'])
def control():
    """Start or stop the simulation."""
    body = request.get_json(force=True)
    action = body.get("action", "toggle")
    if action == "start":
        sim_state["running"] = True
    elif action == "stop":
        sim_state["running"] = False
    else:
        sim_state["running"] = not sim_state["running"]
    return jsonify({"running": sim_state["running"]})


# ---------------------------------------------------------------------------
# RL Agent Routes
# ---------------------------------------------------------------------------
@app.route('/rl/status')
def rl_status():
    """Return RL agent training status."""
    if not rl_agent:
        return jsonify({"available": False, "error": "PyTorch not installed"})
    status = rl_agent.get_status()
    status["available"] = True
    return jsonify(status)


@app.route('/rl/control', methods=['POST'])
def rl_control():
    """Enable or disable the RL autopilot."""
    if not rl_agent:
        return jsonify({"available": False, "error": "PyTorch not installed"})
    body = request.get_json(force=True)
    action = body.get("action", "toggle")
    if action == "enable":
        rl_agent.enabled = True
    elif action == "disable":
        rl_agent.enabled = False
    else:
        rl_agent.enabled = not rl_agent.enabled
    return jsonify({"enabled": rl_agent.enabled})


@app.route('/<path:path>')
def static_files(path):
    return send_from_directory('.', path)


if __name__ == '__main__':
    print("🚗  EV Digital Twin server starting on http://localhost:5000")
    app.run(host='0.0.0.0', port=5000, debug=True)
