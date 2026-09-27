-- Removes the demo data added by DEMOPUT_002.sql (tasks go with the account).

DELETE FROM atodo.accounts WHERE email = 'demo@a-to-do.test';
