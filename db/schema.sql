CREATE DATABASE IF NOT EXISTS `Manuscript`
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

USE `Manuscript`;

CREATE TABLE IF NOT EXISTS `Manuscript`.editor_state (
  id TINYINT UNSIGNED NOT NULL PRIMARY KEY CHECK (id = 1),
  columns_per_row TINYINT UNSIGNED NOT NULL CHECK (columns_per_row BETWEEN 5 AND 40),
  max_characters SMALLINT UNSIGNED NULL CHECK (max_characters BETWEEN 1 AND 10000),
  revision INT UNSIGNED NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE `Manuscript`.editor_state
  ADD COLUMN IF NOT EXISTS title VARCHAR(100) NOT NULL DEFAULT '원고지 연습장';

ALTER TABLE `Manuscript`.editor_state
  ADD COLUMN IF NOT EXISTS candidate_number_digits TINYINT UNSIGNED NULL
    CHECK (candidate_number_digits BETWEEN 1 AND 32);

ALTER TABLE `Manuscript`.editor_state
  ADD COLUMN IF NOT EXISTS question_titles JSON NULL;

INSERT INTO `Manuscript`.editor_state (id, columns_per_row, question_titles)
SELECT 1, 40, JSON_ARRAY(JSON_OBJECT('title', '문제 1', 'maxCharacters', 470))
WHERE NOT EXISTS (SELECT 1 FROM `Manuscript`.editor_state WHERE id = 1)
ON DUPLICATE KEY UPDATE id = VALUES(id);

CREATE TABLE IF NOT EXISTS `Manuscript`.candidate_drafts (
  candidate_number VARCHAR(32) NOT NULL,
  candidate_name VARCHAR(80) NOT NULL,
  birth_date DATE NOT NULL,
  question_number TINYINT UNSIGNED NOT NULL DEFAULT 1,
  body MEDIUMTEXT NOT NULL,
  revision INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (candidate_number, candidate_name, birth_date, question_number)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

ALTER TABLE `Manuscript`.candidate_drafts
  ADD COLUMN IF NOT EXISTS saved_at TIMESTAMP(3) NULL DEFAULT NULL;
