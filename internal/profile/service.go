package profile

import (
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
)

// NotFoundError means the requested profile does not exist.
type NotFoundError struct{ ProfileID string }

func (e *NotFoundError) Error() string {
	return fmt.Sprintf("Browser Profile %q was not found", e.ProfileID)
}

// DuplicateError means a profile with that ID already exists.
type DuplicateError struct{ ProfileID string }

func (e *DuplicateError) Error() string {
	return fmt.Sprintf("Browser Profile %q already exists", e.ProfileID)
}

// DeleteDataError means the profile's user-data could not be removed.
type DeleteDataError struct {
	ProfileID string
	Cause     error
}

func (e *DeleteDataError) Error() string {
	return fmt.Sprintf("Failed to delete Browser Profile data for %q: %v", e.ProfileID, e.Cause)
}

// TokenState reports a profile's CDP Token.
type TokenState struct {
	CdpToken           *string `json:"cdp_token"`
	CdpTokenConfigured bool    `json:"cdp_token_configured"`
	ProfileID          string  `json:"profile_id"`
}

// FileStore manages per-profile user-data directories.
type FileStore interface {
	CreateProfileData(profileID string) error
	RemoveProfileData(profileID string) error
}

// DataDir is a profile's persistent user-data directory.
func DataDir(dataRoot, profileID string) string {
	return filepath.Join(dataRoot, "profiles", profileID)
}

type diskStore struct{ dataRoot string }

func (s diskStore) CreateProfileData(profileID string) error {
	return os.MkdirAll(DataDir(s.dataRoot, profileID), 0o755)
}

func (s diskStore) RemoveProfileData(profileID string) error {
	return os.RemoveAll(DataDir(s.dataRoot, profileID))
}

// ServiceOptions configure a Service.
type ServiceOptions struct {
	CreationPlatform string
	CreationRegion   Region
	TokenGenerator   func() string
	DataRoot         string
	FileStore        FileStore
	Repository       *Repository
}

// Service is the profile management API used by HTTP handlers.
type Service struct {
	repo      *Repository
	files     FileStore
	defaults  LaunchFields
	generator func() string
}

// NewService validates deployment defaults and returns a Service.
func NewService(options ServiceOptions) (*Service, error) {
	defaults, err := ResolveCreationDefaults(options.CreationRegion, options.CreationPlatform)
	if err != nil {
		return nil, err
	}
	files := options.FileStore
	if files == nil {
		files = diskStore{dataRoot: options.DataRoot}
	}
	generator := options.TokenGenerator
	if generator == nil {
		generator = defaultTokenGenerator
	}
	return &Service{repo: options.Repository, files: files, defaults: defaults, generator: generator}, nil
}

// Repository exposes the underlying store to the runtime.
func (s *Service) Repository() *Repository { return s.repo }

// CreationDefaults returns a copy of the launch defaults for new profiles.
func (s *Service) CreationDefaults() LaunchFields { return cloneLaunch(s.defaults) }

// Create validates and stores a new profile with its data directory.
func (s *Service) Create(body map[string]any) (*Profile, error) {
	input, err := NormalizeCreate(body, s.defaults)
	if err != nil {
		return nil, err
	}
	if s.repo.Get(input.ProfileID) != nil {
		return nil, &DuplicateError{ProfileID: input.ProfileID}
	}
	if err := s.files.CreateProfileData(input.ProfileID); err != nil {
		return nil, err
	}
	return s.repo.Create(input)
}

// Get returns one profile or nil.
func (s *Service) Get(profileID string) *Profile { return s.repo.Get(profileID) }

// List returns all profiles.
func (s *Service) List() []*Profile { return s.repo.List() }

// Update validates and applies an edit.
func (s *Service) Update(profileID string, body map[string]any) (*Profile, error) {
	input, err := NormalizeUpdate(profileID, body)
	if err != nil {
		return nil, err
	}
	updated, err := s.repo.Update(profileID, input)
	if err != nil {
		return nil, err
	}
	if updated == nil {
		return nil, &NotFoundError{ProfileID: profileID}
	}
	return updated, nil
}

// DeleteStopped removes a stopped profile's data, then its record.
func (s *Service) DeleteStopped(profileID string) error {
	p, err := s.require(profileID)
	if err != nil {
		return err
	}
	if p.InstanceStatus != StatusStopped && p.InstanceStatus != StatusFailed {
		return invalid("Stop the Browser Instance before deleting its profile data")
	}
	if err := s.files.RemoveProfileData(p.ProfileID); err != nil {
		s.repo.RecordDeleteError(p.ProfileID, err.Error())
		return &DeleteDataError{ProfileID: p.ProfileID, Cause: err}
	}
	s.repo.Delete(p.ProfileID)
	return nil
}

// TokensForRedaction lists every configured CDP Token.
func (s *Service) TokensForRedaction() []string {
	var tokens []string
	for _, p := range s.repo.List() {
		if t := p.Token(); t != "" {
			tokens = append(tokens, t)
		}
	}
	return tokens
}

// GetCdpToken reports a profile's token.
func (s *Service) GetCdpToken(profileID string) (TokenState, error) {
	p, err := s.require(profileID)
	if err != nil {
		return TokenState{}, err
	}
	return tokenState(p), nil
}

// CreateCdpToken returns the existing token or creates one.
func (s *Service) CreateCdpToken(profileID string) (TokenState, error) {
	p, err := s.require(profileID)
	if err != nil {
		return TokenState{}, err
	}
	if p.Token() != "" {
		return tokenState(p), nil
	}
	token := s.generator()
	return tokenState(s.repo.SetCdpToken(profileID, &token)), nil
}

// RegenerateCdpToken replaces the token.
func (s *Service) RegenerateCdpToken(profileID string) (TokenState, error) {
	if _, err := s.require(profileID); err != nil {
		return TokenState{}, err
	}
	token := s.generator()
	return tokenState(s.repo.SetCdpToken(profileID, &token)), nil
}

// RevokeCdpToken removes protection from a profile's CDP endpoints.
func (s *Service) RevokeCdpToken(profileID string) error {
	if _, err := s.require(profileID); err != nil {
		return err
	}
	s.repo.SetCdpToken(profileID, nil)
	return nil
}

func (s *Service) require(profileID string) (*Profile, error) {
	p := s.repo.Get(profileID)
	if p == nil {
		return nil, &NotFoundError{ProfileID: profileID}
	}
	return p, nil
}

func tokenState(p *Profile) TokenState {
	return TokenState{CdpToken: p.CdpToken, CdpTokenConfigured: p.Token() != "", ProfileID: p.ProfileID}
}

func defaultTokenGenerator() string {
	buffer := make([]byte, 24)
	_, _ = rand.Read(buffer)
	return "cdp_" + base64.RawURLEncoding.EncodeToString(buffer)
}
