FROM python:3.9-slim

# Set working directory
WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    nginx \
    apache2-utils \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements and install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY . .
RUN chmod +x /app/docker-entrypoint.sh

# Expose the nginx public port used by MDVR
EXPOSE 8080

# Start nginx + FastAPI via the bootstrap script
CMD ["/app/docker-entrypoint.sh"]
