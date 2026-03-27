"""
EV Digital Twin — DQN Reinforcement Learning Agent
Live-training Deep Q-Network for EV energy management optimization.

The agent learns in real-time to optimize:
- Driving mode selection (Eco vs Sport)
- Throttle level (Low vs High)
to maximize battery efficiency while maintaining performance.
"""

import torch
import torch.nn as nn
import torch.optim as optim
import numpy as np
import random
from collections import deque
import time

# =========================================================================
# NEURAL NETWORK — Deep Q-Network
# =========================================================================
class DQNetwork(nn.Module):
    """3-layer MLP for Q-value approximation."""

    def __init__(self, state_dim=4, action_dim=4, hidden=128):
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(state_dim, hidden),
            nn.ReLU(),
            nn.LayerNorm(hidden),
            nn.Linear(hidden, hidden),
            nn.ReLU(),
            nn.LayerNorm(hidden),
            nn.Linear(hidden, action_dim),
        )

    def forward(self, x):
        return self.net(x)


# =========================================================================
# REPLAY BUFFER — Experience Replay
# =========================================================================
class ReplayBuffer:
    """Fixed-size circular buffer for experience replay."""

    def __init__(self, capacity=10000):
        self.buffer = deque(maxlen=capacity)

    def push(self, state, action, reward, next_state, done):
        self.buffer.append((state, action, reward, next_state, done))

    def sample(self, batch_size=64):
        batch = random.sample(self.buffer, min(len(self.buffer), batch_size))
        states, actions, rewards, next_states, dones = zip(*batch)
        return (
            torch.FloatTensor(np.array(states)),
            torch.LongTensor(actions),
            torch.FloatTensor(rewards),
            torch.FloatTensor(np.array(next_states)),
            torch.FloatTensor(dones),
        )

    def __len__(self):
        return len(self.buffer)


# =========================================================================
# EV ENVIRONMENT — Simulation Wrapper
# =========================================================================
class EVEnvironment:
    """
    Wraps the EV simulation state into an RL environment.

    State:  [battery/100, rpm/10000, temp/120, mode_flag]
    Actions: 0=Eco+Low, 1=Eco+High, 2=Sport+Low, 3=Sport+High
    Reward: efficiency-based with safety penalties
    """

    ACTION_MAP = {
        0: {"mode": "eco",    "throttle": "low"},
        1: {"mode": "eco",    "throttle": "high"},
        2: {"mode": "normal", "throttle": "low"},
        3: {"mode": "normal", "throttle": "high"},
        4: {"mode": "sport",  "throttle": "low"},
        5: {"mode": "sport",  "throttle": "high"},
        6: {"mode": "wet",    "throttle": "low"},
        7: {"mode": "wet",    "throttle": "high"},
    }

    ACTION_NAMES = [
        "Eco Low", "Eco High",
        "Normal Low", "Normal High",
        "Sport Low", "Sport High",
        "Wet Low", "Wet High"
    ]

    def __init__(self):
        self.step_count = 0
        self.episode_reward = 0.0
        self.episode = 0
        self.prev_battery = 85.0
        self.prev_action = None  # Track last action to penalize mode switches

    def get_state(self, sim_state):
        """Convert simulation state dict to normalized state vector."""
        battery = sim_state.get("battery", 50) / 100.0
        rpm = sim_state.get("rpm", 3000) / 10000.0
        temp = sim_state.get("temp", 45) / 120.0
        mode_val = {"eco": 0.0, "normal": 0.33, "sport": 0.66, "wet": 1.0}.get(sim_state.get("mode", "eco"), 0.0)
        return np.array([battery, rpm, temp, mode_val], dtype=np.float32)

    def compute_reward(self, sim_state, action):
        """
        Reward function:
        - Positive: staying alive, efficient battery use
        - Negative: high temperature, battery drain, overheating
        """
        battery = sim_state.get("battery", 50)
        temp = sim_state.get("temp", 45)
        rpm = sim_state.get("rpm", 3000)

        reward = 0.0

        # +1 base reward for each step survived
        reward += 1.0

        # Battery efficiency: reward for maintaining charge
        battery_drain = self.prev_battery - battery
        if battery_drain > 0:
            reward -= battery_drain * 2.0  # penalize drain
        else:
            reward += 0.5  # reward for stable/charging

        # Temperature management
        if temp < 50:
            reward += 1.0   # cool is great
        elif temp < 70:
            reward += 0.3   # warm is okay
        elif temp < 85:
            reward -= 1.0   # getting hot
        else:
            reward -= 5.0   # overheating — big penalty

        # Performance bonus: moderate RPM is efficient
        if 1500 < rpm < 4000:
            reward += 0.5  # sweet spot
        elif rpm > 7000:
            reward -= 1.0  # wasteful

        # Eco mode bonus for efficiency
        action_info = self.ACTION_MAP[action]
        if action_info["mode"] == "eco" and action_info["throttle"] == "low":
            reward += 0.3  # eco-friendly bonus

        # MODE SWITCHING PENALTY — strongly discourage rapid mode changes
        if self.prev_action is not None:
            prev_mode = self.ACTION_MAP[self.prev_action]["mode"]
            curr_mode = action_info["mode"]
            if prev_mode != curr_mode:
                reward -= 3.0  # heavy penalty for switching modes

        # Critical penalties
        if battery <= 10:
            reward -= 10.0  # nearly dead battery
        if temp >= 95:
            reward -= 10.0  # critical overheat

        self.prev_battery = battery
        self.prev_action = action
        return reward

    def is_done(self, sim_state):
        """Episode ends on critical failure."""
        battery = sim_state.get("battery", 50)
        temp = sim_state.get("temp", 45)
        return battery <= 5 or temp >= 110

    def reset_episode(self):
        """Reset episode tracking."""
        self.episode += 1
        self.episode_reward = 0.0
        self.step_count = 0
        self.prev_battery = 85.0


# =========================================================================
# DQN AGENT — Main RL Agent
# =========================================================================
class DQNAgent:
    """
    Deep Q-Network agent with:
    - Epsilon-greedy exploration (decaying)
    - Experience replay
    - Target network with soft updates
    - Live training on each step
    """

    def __init__(
        self,
        state_dim=4,
        action_dim=8,
        lr=1e-3,
        gamma=0.99,
        epsilon_start=1.0,
        epsilon_end=0.05,
        epsilon_decay=500,
        batch_size=64,
        tau=0.005,
        buffer_size=10000,
    ):
        self.state_dim = state_dim
        self.action_dim = action_dim
        self.gamma = gamma
        self.batch_size = batch_size
        self.tau = tau

        # Epsilon schedule
        self.epsilon = epsilon_start
        self.epsilon_start = epsilon_start
        self.epsilon_end = epsilon_end
        self.epsilon_decay = epsilon_decay

        # Networks
        self.policy_net = DQNetwork(state_dim, action_dim)
        self.target_net = DQNetwork(state_dim, action_dim)
        self.target_net.load_state_dict(self.policy_net.state_dict())
        self.target_net.eval()

        # Optimizer
        self.optimizer = optim.Adam(self.policy_net.parameters(), lr=lr)

        # Replay buffer
        self.memory = ReplayBuffer(buffer_size)

        # Environment wrapper
        self.env = EVEnvironment()

        # Agent state
        self.enabled = False
        self.total_steps = 0
        self.last_loss = 0.0
        self.last_action = 0
        self.last_reward = 0.0
        self.last_q_values = [0.0] * action_dim
        self.reward_history = deque(maxlen=100)
        self.loss_history = deque(maxlen=100)
        self.prev_state = None

    def select_action(self, state):
        """Epsilon-greedy action selection."""
        self.total_steps += 1

        # Decay epsilon
        self.epsilon = self.epsilon_end + (self.epsilon_start - self.epsilon_end) * \
            np.exp(-self.total_steps / self.epsilon_decay)

        if random.random() < self.epsilon:
            # Explore
            action = random.randint(0, self.action_dim - 1)
        else:
            # Exploit
            with torch.no_grad():
                state_tensor = torch.FloatTensor(state).unsqueeze(0)
                q_values = self.policy_net(state_tensor)
                self.last_q_values = q_values.squeeze().tolist()
                action = q_values.argmax(dim=1).item()

        self.last_action = action
        return action

    def train_step(self):
        """One gradient step from replay buffer."""
        if len(self.memory) < self.batch_size:
            return 0.0

        states, actions, rewards, next_states, dones = self.memory.sample(self.batch_size)

        # Current Q values
        current_q = self.policy_net(states).gather(1, actions.unsqueeze(1)).squeeze(1)

        # Target Q values (Double DQN style)
        with torch.no_grad():
            # Use policy net to select actions
            next_actions = self.policy_net(next_states).argmax(dim=1)
            # Use target net to evaluate
            next_q = self.target_net(next_states).gather(1, next_actions.unsqueeze(1)).squeeze(1)
            target_q = rewards + self.gamma * next_q * (1 - dones)

        # Huber loss (smooth L1)
        loss = nn.SmoothL1Loss()(current_q, target_q)

        # Optimize
        self.optimizer.zero_grad()
        loss.backward()
        torch.nn.utils.clip_grad_norm_(self.policy_net.parameters(), 1.0)
        self.optimizer.step()

        # Soft update target network
        for target_param, policy_param in zip(
            self.target_net.parameters(), self.policy_net.parameters()
        ):
            target_param.data.copy_(
                self.tau * policy_param.data + (1.0 - self.tau) * target_param.data
            )

        self.last_loss = loss.item()
        self.loss_history.append(self.last_loss)
        return self.last_loss

    def step(self, sim_state):
        """
        Full agent step: observe → act → learn.
        Called once per simulation tick.
        Returns the action to apply.
        """
        current_state = self.env.get_state(sim_state)

        # If we have a previous state, store transition and learn
        if self.prev_state is not None:
            reward = self.env.compute_reward(sim_state, self.last_action)
            done = self.env.is_done(sim_state)
            self.last_reward = reward
            self.env.episode_reward += reward
            self.env.step_count += 1

            self.memory.push(self.prev_state, self.last_action, reward, current_state, float(done))
            self.train_step()

            if done:
                self.reward_history.append(self.env.episode_reward)
                self.env.reset_episode()

        # Select next action
        action = self.select_action(current_state)
        self.prev_state = current_state

        return action

    def get_action_command(self, action):
        """Convert action index to simulation command."""
        return self.env.ACTION_MAP[action]

    def get_status(self):
        """Return current agent status for API (all values as native Python types)."""
        avg_reward = float(np.mean(list(self.reward_history))) if self.reward_history else 0.0
        avg_loss = float(np.mean(list(self.loss_history))) if self.loss_history else 0.0

        return {
            "enabled": bool(self.enabled),
            "epsilon": float(round(float(self.epsilon), 4)),
            "episode": int(self.env.episode),
            "step": int(self.total_steps),
            "last_action": int(self.last_action),
            "action_name": str(self.env.ACTION_NAMES[self.last_action]),
            "last_reward": float(round(float(self.last_reward), 2)),
            "episode_reward": float(round(float(self.env.episode_reward), 2)),
            "avg_reward": float(round(avg_reward, 2)),
            "last_loss": float(round(float(self.last_loss), 6)),
            "avg_loss": float(round(avg_loss, 6)),
            "q_values": [float(round(float(q), 3)) for q in self.last_q_values],
            "action_names": list(self.env.ACTION_NAMES),
            "memory_size": int(len(self.memory)),
            "exploring": bool(float(self.epsilon) > 0.3),
        }

