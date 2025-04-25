#!/bin/bash

LOG_FILE="/mnt/c/Users/Charl/solana_node_bot/monitor.log"
BOT_SCRIPT="/mnt/c/Users/Charl/solana_node_bot/raydium_sniper.js"
RAYDIUM_LOG="/mnt/c/Users/Charl/solana_node_bot/raydium_sniper.log"

# Function to log messages with timestamps, including errors
log_message() {
  echo "[$(date -u '+%Y-%m-%dT%H:%M:%S.%MZ')] $1" >> "$LOG_FILE" 2>> "$LOG_FILE.error"
}

# Function to rotate raydium_sniper.log daily
rotate_log() {
  local current_date=$(date -u '+%Y-%m-%d')
  local backup_log="${RAYDIUM_LOG}.${current_date}.bak"
  if [ -f "$RAYDIUM_LOG" ]; then
    mv "$RAYDIUM_LOG" "$backup_log"
    touch "$RAYDIUM_LOG"
    chmod 666 "$RAYDIUM_LOG"
    log_message "Rotated raydium_sniper.log to $backup_log"
  fi
}

# Create log files if they don't exist
touch "$LOG_FILE"
touch "$LOG_FILE.error"

log_message "Starting bot monitoring script"

# Track the last rotation date
last_rotation=$(date -u '+%Y-%m-%d')

while true; do
  # Check if the bot process is running
  if ! ps aux | grep "[n]ode $BOT_SCRIPT" > /dev/null; then
    log_message "Bot process not found, restarting..."
    nohup node "$BOT_SCRIPT" &
    log_message "Bot restarted with PID $!"
  else
    log_message "Bot is running"
  fi

  # Check if a new day has started to rotate logs
  current_date=$(date -u '+%Y-%m-%d')
  if [ "$current_date" != "$last_rotation" ]; then
    rotate_log
    last_rotation="$current_date"
  fi

  # Sleep for 5 minutes (300 seconds)
  sleep 300
done