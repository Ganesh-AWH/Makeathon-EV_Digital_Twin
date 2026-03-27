import streamlit as st
import subprocess
import json
from collections import deque
from datetime import datetime
import pandas as pd
import plotly.graph_objects as go
import time
import base64
import streamlit.components.v1 as components

# ---------------- PAGE CONFIG ----------------
st.set_page_config(page_title="EV Digital Twin", layout="wide")

# ---------------- SESSION STATE ----------------
if "data_history" not in st.session_state:
    st.session_state.data_history = deque(maxlen=200)

if "latest_data" not in st.session_state:
    st.session_state.latest_data = None

if "process" not in st.session_state:
    st.session_state.process = None

# ---------------- MQTT ----------------
def start_mqtt():
    if st.session_state.process is None:
        st.session_state.process = subprocess.Popen(
            ["mosquitto_sub", "-h", "localhost", "-t", "ev/sensor/data"],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            bufsize=1
        )

def stop_mqtt():
    if st.session_state.process:
        st.session_state.process.kill()
        st.session_state.process = None

# ---------------- READ DATA ----------------
def read_data():
    process = st.session_state.process

    if process and process.stdout:
        line = process.stdout.readline()

        if line:
            try:
                data = json.loads(line.strip())

                temp = float(data.get("temperature", 25))
                hum = float(data.get("humidity", 50))

                voltage = round(400 + (temp - 25) * 0.5, 1)
                soc = round((voltage - 300) / (850 - 300) * 100, 1)

                point = {
                    "timestamp": datetime.now(),
                    "temperature": temp,
                    "humidity": hum,
                    "voltage": voltage,
                    "soc": soc
                }

                st.session_state.latest_data = point
                st.session_state.data_history.append(point)

            except json.JSONDecodeError:
                print("⚠️ Skipping bad JSON")

# ---------------- 3D MODEL (FIXED) ----------------
def show_3d_model(model_path):
    try:
        with open(model_path, "rb") as f:
            model_data = f.read()
            encoded = base64.b64encode(model_data).decode()

        html_code = f"""
        <!DOCTYPE html>
        <html>
        <head>
            <script type="module" src="https://unpkg.com/@google/model-viewer/dist/model-viewer.min.js"></script>
        </head>
        <body style="margin:0;">
            <model-viewer 
                src="data:model/gltf-binary;base64,{encoded}"
                auto-rotate 
                camera-controls 
                exposure="1"
                shadow-intensity="1"
                style="width: 100%; height: 500px;">
            </model-viewer>
        </body>
        </html>
        """
        components.html(html_code, height=500)

    except FileNotFoundError:
        st.error("❌ 3D model file not found. Put .glb in same folder")

# ---------------- UI ----------------
st.title("🚗 EV Digital Twin Dashboard")

col1, col2 = st.columns(2)

with col1:
    if st.button("▶ Start MQTT"):
        start_mqtt()

with col2:
    if st.button("⏹ Stop MQTT"):
        stop_mqtt()

# ---------------- PROCESS DATA ----------------
read_data()

# ---------------- DISPLAY ----------------
if st.session_state.latest_data:
    d = st.session_state.latest_data

    # 🔋 Battery Bar
    st.subheader("🔋 Battery Status")

    color = "green" if d["soc"] > 50 else "orange" if d["soc"] > 20 else "red"

    st.markdown(f"""
    <div style="border:2px solid #555; border-radius:10px; height:35px;">
        <div style="width:{d['soc']}%; height:100%; background:{color}; text-align:center;">
            {d['soc']}%
        </div>
    </div>
    """, unsafe_allow_html=True)

    # 📊 Metrics
    c1, c2, c3, c4 = st.columns(4)

    c1.metric("🔋 Voltage", f"{d['voltage']} V")
    c2.metric("🌡 Temperature", f"{d['temperature']} °C")
    c3.metric("💧 Humidity", f"{d['humidity']} %")
    c4.metric("⚡ SOC", f"{d['soc']} %")

    # 🚗 3D MODEL
    st.subheader("🚗 3D EV Digital Twin")
    show_3d_model("ev_sport_car_test.glb")

    # 📈 Graphs
    if len(st.session_state.data_history) > 1:
        df = pd.DataFrame(list(st.session_state.data_history))

        st.subheader("📊 Real-Time Graphs")

        fig1 = go.Figure()
        fig1.add_trace(go.Scatter(
            x=df["timestamp"],
            y=df["voltage"],
            mode="lines+markers",
            name="Voltage"
        ))
        st.plotly_chart(fig1, use_container_width=True)

        fig2 = go.Figure()
        fig2.add_trace(go.Scatter(
            x=df["timestamp"],
            y=df["temperature"],
            name="Temperature"
        ))
        fig2.add_trace(go.Scatter(
            x=df["timestamp"],
            y=df["humidity"],
            name="Humidity"
        ))
        st.plotly_chart(fig2, use_container_width=True)

else:
    st.info("Waiting for MQTT data...")

# ---------------- AUTO REFRESH ----------------
time.sleep(1)
st.rerun()