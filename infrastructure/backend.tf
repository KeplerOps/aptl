# SPDX-License-Identifier: BUSL-1.1

terraform {
  backend "s3" {
    bucket         = "aptl-main-d4cdc195-38f2-28ee-7f89-717079b14103"
    key            = "terraform.tfstate"
    region         = "us-east-1"
    encrypt        = true
    dynamodb_table = "aptl-main-locks-d4cdc195-38f2-28ee-7f89-717079b14103"
  }
}
